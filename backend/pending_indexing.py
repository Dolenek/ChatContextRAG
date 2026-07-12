import uuid
from typing import Callable

import psycopg

from backend.indexing_job_sql import queue_job_sql
from backend.openai_gateway import ExternalIntegrationError


class PostgresPendingIndexingJobCreator:
    def __init__(self, ensure_schema: Callable[[], None], connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def queue(self) -> str:
        self.ensure_schema()
        session_id = str(uuid.uuid4())
        job_id = str(uuid.uuid4())
        try:
            with self.connect() as connection:
                self._lock_queue_creation(connection)
                index_id = self._active_index_id(connection)
                self._create_session(connection, session_id)
                inserted = connection.execute(
                    self._insert_pending_messages_sql(), (session_id, index_id, index_id),
                ).rowcount
                if inserted == 0:
                    raise ValueError("Žádné nezaindexované zprávy nečekají na nový job.")
                message_count = self._update_session_count(connection, session_id)
                connection.execute(
                    queue_job_sql(), (job_id, session_id, index_id, message_count),
                )
            return job_id
        except psycopg.Error as error:
            raise ExternalIntegrationError(
                "PostgreSQL pending indexing job creation failed."
            ) from error

    @staticmethod
    def _lock_queue_creation(connection) -> None:
        connection.execute("SELECT pg_advisory_xact_lock(1812199001)")

    @staticmethod
    def _active_index_id(connection) -> str:
        row = connection.execute(
            "SELECT active_embedding_index_id FROM rag_application_settings WHERE id=1"
        ).fetchone()
        if not row or not row[0]:
            raise ValueError("No active embedding index is configured.")
        return row[0]

    @staticmethod
    def _create_session(connection, session_id: str) -> None:
        connection.execute(
            """INSERT INTO ingestion_sessions
               (id,guild_id,channel_id,channel,status,finished_at)
               VALUES (%s,'__maintenance__','__pending__',
                       'Nezaindexované zprávy','completed',NOW())""",
            (session_id,),
        )

    @staticmethod
    def _update_session_count(connection, session_id: str) -> int:
        return connection.execute(
            """UPDATE ingestion_sessions SET raw_message_count=(
                   SELECT COUNT(*) FROM ingestion_session_messages WHERE session_id=%s)
               WHERE id=%s RETURNING raw_message_count""",
            (session_id, session_id),
        ).fetchone()[0]

    @staticmethod
    def _insert_pending_messages_sql() -> str:
        return """INSERT INTO ingestion_session_messages(session_id,message_id)
            SELECT %s,raw.external_id FROM source_messages raw
            LEFT JOIN rag_chunk_messages indexed ON indexed.message_id=raw.external_id
              AND indexed.embedding_index_id=%s
            WHERE indexed.message_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM ingestion_session_messages active_message
              JOIN indexing_jobs active_job
                ON active_job.session_id=active_message.session_id
              WHERE active_message.message_id=raw.external_id
                AND active_job.embedding_index_id=%s
                AND active_job.status IN ('queued','running'))
            ON CONFLICT DO NOTHING"""
