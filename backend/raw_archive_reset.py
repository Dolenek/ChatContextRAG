from typing import Callable, Optional

from backend.read_models.store import PostgresReadModelStore


class RawArchiveResetter:
    def __init__(
        self, ensure_schema: Callable[[], None], open_connection: Callable,
        read_model_store: Optional[PostgresReadModelStore],
    ) -> None:
        self.ensure_schema = ensure_schema
        self.open_connection = open_connection
        self.read_model_store = read_model_store

    def delete_all(self) -> tuple:
        self.ensure_schema()
        with self.open_connection() as connection:
            chunk_count = connection.execute("SELECT COUNT(*) FROM rag_chunks").fetchone()[0]
            message_count = connection.execute("SELECT COUNT(*) FROM source_messages").fetchone()[0]
            connection.execute(self._truncate_sql())
            connection.execute(
                "UPDATE embedding_indexes SET status='ready',last_error=NULL,updated_at=NOW()"
            )
            if self.read_model_store:
                self.read_model_store.reset(connection)
        return chunk_count, message_count

    @staticmethod
    def _truncate_sql() -> str:
        return """TRUNCATE rag_staged_chunk_messages, rag_staged_chunks,
            rag_chunk_messages, rag_chunks, indexing_job_messages, indexing_jobs,
            ingestion_session_messages, ingestion_sessions, integration_sync_states,
            source_messages, message_contents CASCADE"""
