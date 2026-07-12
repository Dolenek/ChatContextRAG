import threading
from typing import Iterable, List, Optional, Sequence, Set

import numpy as np
import psycopg
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb

from backend.models import ChatScope, DatabaseOverview
from backend.openai_gateway import ExternalIntegrationError
from backend.postgres_overview_reader import PostgresOverviewReader
from backend.repository import VectorRepository
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class PostgresVectorRepository(VectorRepository):
    def __init__(self, database_dsn: str, dimensions: int) -> None:
        if not 1 <= dimensions <= 2000:
            raise ValueError("pgvector dimensions must be between 1 and 2000")
        self.database_dsn = database_dsn
        self.dimensions = dimensions
        self._initialized = False
        self._initialization_lock = threading.Lock()
        self.overview_reader = PostgresOverviewReader(database_dsn)

    def upsert_chunks(self, chunks: Iterable[EmbeddedChunk]) -> int:
        chunk_list = list(chunks)
        self._ensure_schema()
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.executemany(
                        self._upsert_sql(), [self._to_row(item) for item in chunk_list]
                    )
            return len(chunk_list)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL vector write failed.") from error

    def search_similar(
        self, query_embedding: Sequence[float], limit: int = 5,
        scope: Optional[ChatScope] = None,
    ) -> List[RetrievedChunk]:
        self._ensure_schema()
        vector = np.asarray(query_embedding, dtype=np.float32)
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    self._search_sql(), self._search_parameters(vector, limit, scope),
                ).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL vector search failed.") from error
        return [self._to_retrieved_chunk(row) for row in rows]

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        self._ensure_schema()
        return self.overview_reader.get_overview(limit, offset)

    def delete_all(self) -> int:
        self._ensure_schema()
        try:
            with self._connect() as connection:
                result = connection.execute("DELETE FROM conversation_chunks")
                return result.rowcount
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL database clear failed.") from error

    def existing_source_message_ids(self, external_ids: Sequence[str]) -> Set[str]:
        if not external_ids:
            return set()
        self._ensure_schema()
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """
                    SELECT DISTINCT source_id FROM conversation_chunks,
                    LATERAL UNNEST(source_message_ids) AS source_id
                    WHERE source_id = ANY(%s)
                    """,
                    (list(external_ids),),
                ).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL deduplication query failed.") from error
        return {row[0] for row in rows}

    def find_oldest_source_message_id(
        self, channel_id: str, channel_name: Optional[str]
    ) -> Optional[str]:
        self._ensure_schema()
        try:
            with self._connect() as connection:
                row = connection.execute(
                    self._oldest_source_message_sql(), (channel_id, channel_name)
                ).fetchone()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL resume-point query failed.") from error
        return row[0] if row else None

    def _ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._initialization_lock:
            if self._initialized:
                return
            self._create_schema()
            self._initialized = True

    def _create_schema(self) -> None:
        try:
            with psycopg.connect(self.database_dsn, autocommit=True) as connection:
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                register_vector(connection)
                connection.execute(self._create_table_sql())
                connection.execute(self._create_index_sql())
                connection.execute(self._create_resume_indexes_sql())
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL vector schema initialization failed.") from error

    def _connect(self) -> psycopg.Connection:
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection

    def _create_table_sql(self) -> str:
        return f"""
            CREATE TABLE IF NOT EXISTS conversation_chunks (
                id TEXT PRIMARY KEY, content TEXT NOT NULL, authors TEXT[] NOT NULL,
                source_message_ids TEXT[] NOT NULL, channel TEXT,
                started_at TIMESTAMPTZ, ended_at TIMESTAMPTZ,
                embedding_model TEXT NOT NULL, embedding vector({self.dimensions}) NOT NULL,
                metadata JSONB NOT NULL DEFAULT '{{}}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """

    @staticmethod
    def _create_index_sql() -> str:
        return """
            CREATE INDEX IF NOT EXISTS conversation_chunks_embedding_hnsw
            ON conversation_chunks USING hnsw (embedding vector_cosine_ops)
        """

    @staticmethod
    def _create_resume_indexes_sql() -> str:
        return """
            CREATE INDEX IF NOT EXISTS conversation_chunks_channel_id
            ON conversation_chunks ((metadata->>'channel_id'));
            CREATE INDEX IF NOT EXISTS conversation_chunks_channel_name
            ON conversation_chunks (channel);
            CREATE INDEX IF NOT EXISTS conversation_chunks_chat_scope
            ON conversation_chunks (
              (COALESCE(metadata->>'source_type','discord')),
              (COALESCE(metadata->>'conversation_id',metadata->>'channel_id'))
            )
        """

    @staticmethod
    def _upsert_sql() -> str:
        return """
            INSERT INTO conversation_chunks
            (id, content, authors, source_message_ids, channel, started_at, ended_at,
             embedding_model, embedding, metadata)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content,
              authors = EXCLUDED.authors, source_message_ids = EXCLUDED.source_message_ids,
              channel = EXCLUDED.channel, started_at = EXCLUDED.started_at,
              ended_at = EXCLUDED.ended_at, embedding = EXCLUDED.embedding,
              embedding_model = EXCLUDED.embedding_model, metadata = EXCLUDED.metadata,
              updated_at = NOW()
        """

    @staticmethod
    def _search_sql() -> str:
        return """
            SELECT content, authors, channel, started_at,
                   1 - (embedding <=> %s) AS similarity_score,
                   source_message_ids, metadata->>'channel_id', metadata->>'guild_id'
            FROM conversation_chunks
            WHERE (%s::text IS NULL OR COALESCE(metadata->>'source_type','discord')=%s)
              AND (%s::text IS NULL OR COALESCE(metadata->>'conversation_id',
                                           metadata->>'channel_id')=%s)
            ORDER BY embedding <=> %s LIMIT %s
        """

    @staticmethod
    def _search_parameters(vector, limit: int, scope: Optional[ChatScope]) -> tuple:
        source_type = scope.source_type if scope else None
        conversation_id = scope.conversation_id if scope else None
        return (
            vector, source_type, source_type, conversation_id, conversation_id,
            vector, limit,
        )

    @staticmethod
    def _oldest_source_message_sql() -> str:
        return """
            SELECT source_id FROM conversation_chunks,
            LATERAL UNNEST(source_message_ids) AS source_id
            WHERE source_id ~ '^[0-9]+$' AND (
                metadata->>'channel_id' = %s OR (
                    COALESCE(metadata->>'channel_id', '') = '' AND channel = %s
                )
            )
            ORDER BY source_id::numeric ASC LIMIT 1
        """

    @staticmethod
    def _to_row(item: EmbeddedChunk) -> tuple:
        chunk = item.chunk
        vector = np.asarray(item.embedding, dtype=np.float32)
        return (
            chunk.chunk_id, chunk.content, chunk.authors, chunk.source_message_ids,
            chunk.channel, chunk.started_at, chunk.ended_at, item.embedding_model,
            vector, Jsonb(chunk.metadata),
        )

    @staticmethod
    def _to_retrieved_chunk(row: tuple) -> RetrievedChunk:
        return RetrievedChunk(
            content=row[0], authors=row[1], channel=row[2], started_at=row[3],
            similarity_score=float(row[4]), source_message_ids=row[5],
            channel_id=row[6], guild_id=row[7],
        )
