import threading
from typing import Iterable, List, Sequence

import psycopg
from pgvector.psycopg import register_vector

from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.index_staging import PostgresIndexStaging
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class PostgresHybridRepository:
    def __init__(self, database_dsn: str, dimensions: int) -> None:
        self.database_dsn = database_dsn
        self.dimensions = dimensions
        self._initialized = False
        self._lock = threading.Lock()
        self.staging = PostgresIndexStaging(database_dsn, self.ensure_schema)
        self.retrieval = PostgresHybridRetrieval(database_dsn, self.ensure_schema)

    def prepare_staging(self, job_id: str, worker_id: str) -> None:
        self.staging.prepare(job_id, worker_id)

    def stage_chunks(
        self, job_id: str, worker_id: str, chunks: Iterable[EmbeddedChunk],
    ) -> int:
        return self.staging.stage(job_id, worker_id, chunks)

    def commit_staged_chunks(
        self, job_id: str, session_id: str, worker_id: str,
    ) -> bool:
        return self.staging.commit(job_id, session_id, worker_id)

    def search_hybrid(
        self, query: str, query_embedding: Sequence[float], limit: int = 8
    ) -> List[RetrievedChunk]:
        return self.retrieval.search(query, query_embedding, limit)

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
                connection.execute(self.staging.create_schema_sql())
                connection.execute(self._create_index_sql())
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid schema initialization failed.") from error

    def _create_chunks_sql(self) -> str:
        return f"""CREATE TABLE IF NOT EXISTS rag_chunks (
            id TEXT PRIMARY KEY, content TEXT NOT NULL, authors TEXT[] NOT NULL,
            source_message_ids TEXT[] NOT NULL, channel TEXT, started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ, embedding_model TEXT NOT NULL,
            embedding halfvec({self.dimensions}) NOT NULL, metadata JSONB NOT NULL DEFAULT '{{}}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"""

    @staticmethod
    def _create_links_sql() -> str:
        return """CREATE TABLE IF NOT EXISTS rag_chunk_messages (
            chunk_id TEXT REFERENCES rag_chunks(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
            position INTEGER NOT NULL, PRIMARY KEY(chunk_id,message_id))"""

    @staticmethod
    def _create_index_sql() -> str:
        return """CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw
            ON rag_chunks USING hnsw (embedding halfvec_cosine_ops);
            CREATE INDEX IF NOT EXISTS rag_chunk_messages_message
            ON rag_chunk_messages(message_id)"""

    def _connect(self):
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection
