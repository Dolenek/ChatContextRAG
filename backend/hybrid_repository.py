import threading
from typing import Iterable, List, Optional, Sequence

import psycopg
from psycopg import sql
from pgvector.psycopg import register_vector

from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.index_staging import PostgresIndexStaging
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import EmbeddedChunk, RetrievedChunk
from backend.models import ChatScope
from backend.embedding_indexes import DEFAULT_INDEX_ID
from backend.archive_time import ArchiveTimeRange


def _metadata_indexes_sql() -> str:
    return """CREATE INDEX IF NOT EXISTS rag_chunk_messages_message
        ON rag_chunk_messages(message_id);
        CREATE INDEX IF NOT EXISTS rag_chunk_messages_index_message
        ON rag_chunk_messages(embedding_index_id,message_id);
        CREATE INDEX IF NOT EXISTS rag_chunks_overview_recent
        ON rag_chunks(embedding_index_id,updated_at DESC,id DESC);
        CREATE INDEX IF NOT EXISTS rag_chunks_chat_scope
        ON rag_chunks (
          (COALESCE(metadata->>'source_type','discord')),
          (COALESCE(metadata->>'conversation_id',metadata->>'channel_id'))
        );
        CREATE INDEX IF NOT EXISTS rag_chunks_time_range
        ON rag_chunks(embedding_index_id,started_at,ended_at)"""


class PostgresHybridRepository:
    _create_metadata_indexes_sql = staticmethod(_metadata_indexes_sql)
    def __init__(self, database_dsn: str, dimensions: int) -> None:
        self.database_dsn = database_dsn
        self.dimensions = dimensions
        self._initialized = False
        self._lock = threading.Lock()
        self.staging = PostgresIndexStaging(database_dsn, self.ensure_schema)
        self.retrieval = PostgresHybridRetrieval(database_dsn, self.ensure_schema)

    def prepare_staging(
        self, job_id: str, worker_id: str, embedding_index_id: str,
    ) -> None:
        self.staging.prepare(job_id, worker_id, embedding_index_id)

    def stage_chunks(
        self, job_id: str, worker_id: str, embedding_index_id: str,
        chunks: Iterable[EmbeddedChunk],
    ) -> int:
        return self.staging.stage(job_id, worker_id, embedding_index_id, chunks)

    def commit_staged_chunks(
        self, job_id: str, session_id: str, worker_id: str,
        embedding_index_id: str, job_type: str,
    ) -> bool:
        return self.staging.commit(
            job_id, session_id, worker_id, embedding_index_id, job_type,
        )

    def search_hybrid(
        self, query: str, query_embedding: Sequence[float], limit: int = 8,
        scope: Optional[ChatScope] = None, embedding_index_id: str = DEFAULT_INDEX_ID,
        dimensions: Optional[int] = None,
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[RetrievedChunk]:
        return self.retrieval.search(
            query, query_embedding, limit, scope, embedding_index_id,
            dimensions or self.dimensions, time_range,
        )

    def has_indexed_chunks(self) -> bool:
        self.ensure_schema()
        with self._connect() as connection:
            return bool(connection.execute("SELECT EXISTS(SELECT 1 FROM rag_chunks)").fetchone()[0])

    def ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._create_schema()
            self._initialized = True

    def _create_schema(self) -> None:
        try:
            with psycopg.connect(self.database_dsn, autocommit=True) as connection:
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                register_vector(connection)
                connection.execute(self._create_chunks_sql())
                connection.execute(self._create_links_sql())
                self._migrate_legacy_schema(connection)
                self._copy_legacy_chunks(connection)
                self._reset_legacy_staging(connection)
                connection.execute(self.staging.create_schema_sql())
                self._ensure_model_indexes(connection)
                connection.execute(self._create_metadata_indexes_sql())
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid schema initialization failed.") from error

    def _create_chunks_sql(self) -> str:
        return """CREATE TABLE IF NOT EXISTS rag_chunks (
            embedding_index_id TEXT NOT NULL REFERENCES embedding_indexes(id) ON DELETE CASCADE,
            id TEXT NOT NULL, content TEXT NOT NULL, authors TEXT[] NOT NULL,
            source_message_ids TEXT[] NOT NULL, channel TEXT, started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ, embedding_model TEXT NOT NULL,
            embedding halfvec NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY(embedding_index_id,id))"""

    @staticmethod
    def _create_links_sql() -> str:
        return """CREATE TABLE IF NOT EXISTS rag_chunk_messages (
            embedding_index_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
            message_id TEXT REFERENCES source_messages(external_id) ON DELETE CASCADE,
            position INTEGER NOT NULL,
            PRIMARY KEY(embedding_index_id,chunk_id,message_id),
            FOREIGN KEY(embedding_index_id,chunk_id)
              REFERENCES rag_chunks(embedding_index_id,id) ON DELETE CASCADE)"""

    @staticmethod
    def _migrate_legacy_schema(connection) -> None:
        column = connection.execute(
            """SELECT 1 FROM information_schema.columns
               WHERE table_name='rag_chunks' AND column_name='embedding_index_id'"""
        ).fetchone()
        if column:
            return
        connection.execute("DROP INDEX IF EXISTS rag_chunks_embedding_hnsw")
        connection.execute("DROP TABLE IF EXISTS rag_staged_chunk_messages,rag_staged_chunks")
        connection.execute("ALTER TABLE rag_chunk_messages DROP CONSTRAINT IF EXISTS rag_chunk_messages_chunk_id_fkey")
        connection.execute("ALTER TABLE rag_chunk_messages DROP CONSTRAINT IF EXISTS rag_chunk_messages_pkey")
        connection.execute("ALTER TABLE rag_chunks DROP CONSTRAINT IF EXISTS rag_chunks_pkey")
        connection.execute("ALTER TABLE rag_chunks ADD COLUMN embedding_index_id TEXT")
        connection.execute("UPDATE rag_chunks SET embedding_index_id=%s", (DEFAULT_INDEX_ID,))
        connection.execute("ALTER TABLE rag_chunks ALTER COLUMN embedding_index_id SET NOT NULL")
        connection.execute("ALTER TABLE rag_chunks ALTER COLUMN embedding TYPE halfvec USING embedding::halfvec")
        connection.execute("ALTER TABLE rag_chunks ADD PRIMARY KEY(embedding_index_id,id)")
        connection.execute("ALTER TABLE rag_chunks ADD CONSTRAINT rag_chunks_embedding_index_fkey "
                           "FOREIGN KEY(embedding_index_id) REFERENCES embedding_indexes(id) ON DELETE CASCADE")
        connection.execute("ALTER TABLE rag_chunk_messages ADD COLUMN embedding_index_id TEXT")
        connection.execute("UPDATE rag_chunk_messages SET embedding_index_id=%s", (DEFAULT_INDEX_ID,))
        connection.execute("ALTER TABLE rag_chunk_messages ALTER COLUMN embedding_index_id SET NOT NULL")
        connection.execute("ALTER TABLE rag_chunk_messages ADD PRIMARY KEY(embedding_index_id,chunk_id,message_id)")
        connection.execute("ALTER TABLE rag_chunk_messages ADD CONSTRAINT rag_chunk_messages_chunk_fkey "
                           "FOREIGN KEY(embedding_index_id,chunk_id) REFERENCES "
                           "rag_chunks(embedding_index_id,id) ON DELETE CASCADE")

    @staticmethod
    def _ensure_model_indexes(connection) -> None:
        for index_id, dimensions in connection.execute(
            "SELECT id,dimensions FROM embedding_indexes"
        ).fetchall():
            if not 1 <= dimensions <= 4000:
                continue
            safe_name = "rag_embedding_" + index_id.replace("-", "_") + "_hnsw"
            statement = sql.SQL(
                "CREATE INDEX IF NOT EXISTS {} ON rag_chunks USING hnsw "
                "((embedding::halfvec({})) halfvec_cosine_ops) WHERE embedding_index_id={}"
            ).format(sql.Identifier(safe_name), sql.Literal(dimensions), sql.Literal(index_id))
            connection.execute(statement)

    @staticmethod
    def _reset_legacy_staging(connection) -> None:
        exists = connection.execute("SELECT to_regclass('rag_staged_chunks')").fetchone()[0]
        if not exists:
            return
        column = connection.execute(
            """SELECT 1 FROM information_schema.columns WHERE table_name='rag_staged_chunks'
               AND column_name='embedding_index_id'"""
        ).fetchone()
        if column:
            return
        connection.execute("DROP TABLE rag_staged_chunk_messages,rag_staged_chunks")
        connection.execute("""UPDATE indexing_jobs SET status='queued',worker_id=NULL,
            lease_expires_at=NULL,started_at=NULL WHERE status='running'""")

    @staticmethod
    def _copy_legacy_chunks(connection) -> None:
        legacy = connection.execute("SELECT to_regclass('conversation_chunks')").fetchone()[0]
        if not legacy:
            return
        has_chunks = connection.execute("SELECT EXISTS(SELECT 1 FROM rag_chunks)").fetchone()[0]
        if has_chunks:
            return
        connection.execute("""INSERT INTO rag_chunks
            (embedding_index_id,id,content,authors,source_message_ids,channel,
             started_at,ended_at,embedding_model,embedding,metadata,updated_at)
            SELECT %s,id,content,authors,source_message_ids,channel,started_at,ended_at,
                   embedding_model,embedding::halfvec,metadata,updated_at
            FROM conversation_chunks ON CONFLICT DO NOTHING""", (DEFAULT_INDEX_ID,))
        connection.execute("""INSERT INTO rag_chunk_messages
            (embedding_index_id,chunk_id,message_id,position)
            SELECT %s,legacy.id,message_id,position-1
            FROM conversation_chunks legacy,
                 UNNEST(legacy.source_message_ids) WITH ORDINALITY source(message_id,position)
            JOIN source_messages raw ON raw.external_id=source.message_id
            ON CONFLICT DO NOTHING""", (DEFAULT_INDEX_ID,))

    def ensure_model_index(self, index_id: str, dimensions: int) -> None:
        self.ensure_schema()
        with self._connect() as connection:
            safe_name = "rag_embedding_" + index_id.replace("-", "_") + "_hnsw"
            statement = sql.SQL(
                "CREATE INDEX IF NOT EXISTS {} ON rag_chunks USING hnsw "
                "((embedding::halfvec({})) halfvec_cosine_ops) WHERE embedding_index_id={}"
            ).format(sql.Identifier(safe_name), sql.Literal(dimensions), sql.Literal(index_id))
            connection.execute(statement)

    def drop_model_index(self, index_id: str) -> None:
        self.ensure_schema()
        safe_name = "rag_embedding_" + index_id.replace("-", "_") + "_hnsw"
        with self._connect() as connection:
            connection.execute(
                sql.SQL("DROP INDEX IF EXISTS {}").format(sql.Identifier(safe_name))
            )

    def _connect(self):
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection
