import threading
import uuid
from typing import Iterator, List, Optional, Sequence

import psycopg

from backend.indexing_job_repository import PostgresIndexingJobRepository
from backend.models import IndexingJobView, IngestionSessionRequest, IngestionSessionView
from backend.openai_gateway import ExternalIntegrationError
from backend.pending_indexing import PostgresPendingIndexingJobCreator
from backend.raw_message_writer import RawMessageWriter
from backend.raw_schema import raw_schema_statements
from backend.vector_models import NormalizedMessage


class PostgresRawMessageRepository:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn
        self._initialized = False
        self._lock = threading.Lock()
        self.message_writer = RawMessageWriter()
        self.job_repository = PostgresIndexingJobRepository(self.ensure_schema, self._connect)
        self.pending_job_creator = PostgresPendingIndexingJobCreator(
            self.ensure_schema, self._connect,
        )

    def create_session(self, request: IngestionSessionRequest) -> IngestionSessionView:
        self.ensure_schema()
        session_id = str(uuid.uuid4())
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO ingestion_sessions
                   (id, guild_id, channel_id, channel, status)
                   VALUES (%s, %s, %s, %s, 'running')""",
                (session_id, request.guild_id, request.channel_id, request.channel),
            )
        return IngestionSessionView(session_id=session_id, status="running")

    def store_messages(
        self, session_id: str, messages: Sequence[NormalizedMessage]
    ) -> tuple:
        self.ensure_schema()
        try:
            with self._connect() as connection:
                return self.message_writer.store_messages(connection, session_id, messages)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw message write failed.") from error

    def finish_session(self, session_id: str, reason: str) -> IngestionSessionView:
        return self.job_repository.finish_session(session_id, reason)

    def get_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.get(job_id)

    def list_jobs(self, limit: int = 10) -> List[IndexingJobView]:
        return self.job_repository.list(limit)

    def retry_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.retry(job_id)

    def cancel_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.cancel(job_id)

    def queue_pending_messages(self) -> IndexingJobView:
        job_id = self.pending_job_creator.queue()
        return self.job_repository.get(job_id)

    def claim_next_job(self, worker_id: str) -> Optional[IndexingJobView]:
        return self.job_repository.claim_next(worker_id)

    def load_session_messages(self, session_id: str) -> List[NormalizedMessage]:
        return list(self.iter_session_messages(session_id))

    def iter_session_messages(
        self, session_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        self.ensure_schema()
        with self._connect() as connection, connection.cursor(
            name=f"session_{session_id.replace('-', '')[:20]}",
        ) as cursor:
            cursor.itersize = page_size
            cursor.execute(
                """WITH session_ids AS (
                     SELECT message_id FROM ingestion_session_messages WHERE session_id=%s),
                   affected_chunks AS (
                     SELECT DISTINCT chunk_id FROM rag_chunk_messages
                     WHERE message_id IN (SELECT message_id FROM session_ids)),
                   target_ids AS (
                     SELECT message_id FROM session_ids UNION
                     SELECT message_id FROM rag_chunk_messages
                     WHERE chunk_id IN (SELECT chunk_id FROM affected_chunks))
                   SELECT m.external_id, m.author, c.content, m.sent_at, m.channel,
                          m.channel_id, m.guild_id
                   FROM target_ids target
                   JOIN discord_messages m ON m.external_id=target.message_id
                   JOIN message_contents c ON c.content_hash=m.content_hash
                   ORDER BY m.message_order, m.external_id""",
                (session_id,),
            )
            for row in cursor:
                yield NormalizedMessage(*row)

    def iter_indexing_messages(
        self, job_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        self.ensure_schema()
        with self._connect() as connection, connection.cursor(
            name=f"job_{job_id.replace('-', '')[:20]}",
        ) as cursor:
            cursor.itersize = page_size
            cursor.execute(
                """SELECT m.external_id,m.author,c.content,m.sent_at,m.channel,
                          m.channel_id,m.guild_id
                   FROM indexing_job_messages jm
                   JOIN discord_messages m ON m.external_id=jm.message_id
                   JOIN message_contents c ON c.content_hash=m.content_hash
                   WHERE jm.job_id=%s ORDER BY m.message_order,m.external_id""", (job_id,),
            )
            for row in cursor:
                yield NormalizedMessage(*row)

    def update_job_progress(
        self, job_id: str, worker_id: str, processed_messages: int, stored_chunks: int,
    ) -> bool:
        return self.job_repository.update_progress(
            job_id, worker_id, processed_messages, stored_chunks,
        )

    def prepare_job_total(self, job_id: str, session_id: str, worker_id: str) -> int:
        return self.job_repository.prepare_total(job_id, session_id, worker_id)

    def renew_job_lease(self, job_id: str, worker_id: str) -> bool:
        return self.job_repository.renew_lease(job_id, worker_id)

    def fail_job(self, job_id: str, worker_id: str, error: str) -> None:
        self.job_repository.fail(job_id, worker_id, error)

    def find_oldest_message_id(
        self, channel_id: str, channel_name: Optional[str]
    ) -> Optional[str]:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(
                """SELECT external_id FROM discord_messages
                   WHERE channel_id=%s OR (channel_id IS NULL AND channel=%s)
                   ORDER BY message_order, external_id LIMIT 1""",
                (channel_id, channel_name),
            ).fetchone()
        return row[0] if row else None

    def delete_all(self) -> tuple:
        self.ensure_schema()
        with self._connect() as connection:
            chunk_count = connection.execute("SELECT COUNT(*) FROM rag_chunks").fetchone()[0]
            message_count = connection.execute("SELECT COUNT(*) FROM discord_messages").fetchone()[0]
            connection.execute("TRUNCATE rag_staged_chunk_messages, rag_staged_chunks, "
                               "rag_chunk_messages, rag_chunks, indexing_job_messages, indexing_jobs, "
                               "ingestion_session_messages, ingestion_sessions, "
                               "discord_messages, message_contents CASCADE")
        return chunk_count, message_count

    def delete_session(self, session_id: str) -> None:
        self.ensure_schema()
        with self._connect() as connection:
            connection.execute(
                "DELETE FROM indexing_jobs WHERE session_id=%s", (session_id,),
            )
            connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (session_id,))

    def ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._create_schema()
            self._initialized = True

    def _create_schema(self) -> None:
        statements = self._schema_statements()
        try:
            with psycopg.connect(self.database_dsn, autocommit=True) as connection:
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                for statement in statements:
                    connection.execute(statement)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw schema initialization failed.") from error

    @staticmethod
    def _schema_statements() -> List[str]:
        return raw_schema_statements()

    def _connect(self):
        return psycopg.connect(self.database_dsn)
