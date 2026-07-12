import uuid
from typing import Callable, List, Optional

import psycopg

from backend.indexing_job_sql import (
    claim_job_sql, claimable_job_sql, queue_job_sql, renew_lease_sql,
    select_jobs_sql, snapshot_messages_sql,
)
from backend.models import IndexingJobView, IngestionSessionView
from backend.openai_gateway import ExternalIntegrationError


class PostgresIndexingJobRepository:
    def __init__(
        self, ensure_schema: Callable[[], None], connect: Callable,
        lease_seconds: int = 90,
    ) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect
        self.lease_seconds = lease_seconds

    def finish_session(self, session_id: str, reason: str) -> IngestionSessionView:
        self.ensure_schema()
        try:
            with self.connect() as connection:
                row = connection.execute(
                    """UPDATE ingestion_sessions SET status=%s, finished_at=NOW()
                       WHERE id=%s AND status='running' RETURNING raw_message_count""",
                    (reason, session_id),
                ).fetchone()
                if not row:
                    self._raise_session_error(connection, session_id)
                index_rows = connection.execute(
                    """SELECT idx.id FROM embedding_indexes idx
                       LEFT JOIN rag_application_settings settings ON settings.id=1
                       WHERE idx.status='ready' AND idx.auto_sync
                       ORDER BY (idx.id=settings.active_embedding_index_id) DESC,idx.created_at"""
                ).fetchall()
                job_ids = []
                for index_row in index_rows:
                    job_id = str(uuid.uuid4())
                    connection.execute(
                        queue_job_sql(), (job_id, session_id, index_row[0], row[0]),
                    )
                    stored = connection.execute(
                        "SELECT id FROM indexing_jobs WHERE session_id=%s AND embedding_index_id=%s",
                        (session_id, index_row[0]),
                    ).fetchone()[0]
                    job_ids.append(stored)
            return IngestionSessionView(
                session_id=session_id, status=reason, raw_message_count=row[0],
                indexing_job_id=job_ids[0] if job_ids else None,
                indexing_job_ids=job_ids,
            )
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL ingestion finalization failed.") from error

    def get(self, job_id: str) -> IndexingJobView:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(select_jobs_sql("id=%s"), (job_id,)).fetchone()
        if not row:
            raise ValueError("Indexing job was not found.")
        return self._to_view(row)

    def list(self, limit: int) -> List[IndexingJobView]:
        self.ensure_schema()
        with self.connect() as connection:
            rows = connection.execute(
                select_jobs_sql("TRUE") + " ORDER BY created_at DESC LIMIT %s", (limit,)
            ).fetchall()
        return [self._to_view(row) for row in rows]

    def retry(self, job_id: str) -> IndexingJobView:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(
                """UPDATE indexing_jobs SET status='queued', total_messages=0,
                   processed_messages=0, stored_chunks=0, last_error=NULL,
                   started_at=NULL, finished_at=NULL, worker_id=NULL,
                   lease_expires_at=NULL WHERE id=%s
                   AND status IN ('completed','failed','cancelled')
                   AND (finished_at IS NULL OR finished_at<=transaction_timestamp())
                   RETURNING id""",
                (job_id,),
            ).fetchone()
            if not row:
                self._raise_retry_error(connection, job_id)
            self._discard_job_staging(connection, job_id)
        return self.get(job_id)

    def cancel(self, job_id: str) -> IndexingJobView:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(
                """UPDATE indexing_jobs SET status='cancelled', last_error=NULL,
                   finished_at=NOW(), worker_id=NULL, lease_expires_at=NULL
                   WHERE id=%s AND status IN ('queued','running') RETURNING id""",
                (job_id,),
            ).fetchone()
            if row:
                self._discard_job_staging(connection, job_id)
                connection.execute(
                    """UPDATE embedding_indexes SET status='failed',
                       last_error='Initial index build was cancelled.',updated_at=NOW()
                       WHERE id=(SELECT embedding_index_id FROM indexing_jobs WHERE id=%s)
                         AND status='building'""", (job_id,),
                )
        return self.get(job_id)

    def claim_next(self, worker_id: str) -> Optional[IndexingJobView]:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(claimable_job_sql()).fetchone()
            if not row:
                return None
            connection.execute(
                claim_job_sql(), (worker_id, self.lease_seconds, row[0]),
            )
        return self.get(row[0])

    def renew_lease(self, job_id: str, worker_id: str) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                renew_lease_sql(), (self.lease_seconds, job_id, worker_id),
            ).fetchone()
        return bool(row)

    def update_progress(
        self, job_id: str, worker_id: str, processed: int, chunks: int,
    ) -> bool:
        with self.connect() as connection:
            row = connection.execute(
                """UPDATE indexing_jobs SET processed_messages=%s, stored_chunks=%s,
                   lease_expires_at=NOW()+make_interval(secs=>%s)
                   WHERE id=%s AND status='running' AND worker_id=%s RETURNING id""",
                (processed, chunks, self.lease_seconds, job_id, worker_id),
            ).fetchone()
        return bool(row)

    def prepare_total(self, job_id: str, session_id: str, worker_id: str) -> int:
        with self.connect() as connection:
            self._assert_owned_job(connection, job_id, worker_id)
            connection.execute("DELETE FROM indexing_job_messages WHERE job_id=%s", (job_id,))
            connection.execute(
                snapshot_messages_sql(), (session_id, job_id, job_id, job_id),
            )
            count = connection.execute(
                "SELECT COUNT(*) FROM indexing_job_messages WHERE job_id=%s", (job_id,),
            ).fetchone()[0]
            connection.execute(
                """UPDATE indexing_jobs SET total_messages=%s,
                   lease_expires_at=NOW()+make_interval(secs=>%s) WHERE id=%s""",
                (count, self.lease_seconds, job_id),
            )
        return count

    def fail(self, job_id: str, worker_id: str, error: str) -> None:
        with self.connect() as connection:
            row = connection.execute(
                """UPDATE indexing_jobs SET status='failed', last_error=%s,
                   finished_at=NOW(), worker_id=NULL, lease_expires_at=NULL
                   WHERE id=%s AND status='running' AND worker_id=%s RETURNING id""",
                (error[:1000], job_id, worker_id),
            ).fetchone()
            if row:
                self._discard_job_staging(connection, job_id)

    @staticmethod
    def _assert_owned_job(connection, job_id: str, worker_id: str) -> None:
        row = connection.execute(
            """SELECT 1 FROM indexing_jobs WHERE id=%s AND status='running'
               AND worker_id=%s FOR UPDATE""", (job_id, worker_id),
        ).fetchone()
        if not row:
            raise RuntimeError("Indexing job lease is no longer owned by this worker.")

    @staticmethod
    def _raise_session_error(connection, session_id: str) -> None:
        row = connection.execute(
            "SELECT 1 FROM ingestion_sessions WHERE id=%s", (session_id,),
        ).fetchone()
        if not row:
            raise ValueError("Ingestion session was not found.")
        raise ValueError("Ingestion session is not running.")

    @staticmethod
    def _raise_retry_error(connection, job_id: str) -> None:
        row = connection.execute(
            "SELECT status FROM indexing_jobs WHERE id=%s", (job_id,),
        ).fetchone()
        if not row:
            raise ValueError("Indexing job was not found.")
        raise ValueError("Only a completed, failed, or cancelled indexing job can be retried.")

    @staticmethod
    def _discard_job_staging(connection, job_id: str) -> None:
        row = connection.execute("SELECT to_regclass('rag_staged_chunks')").fetchone()
        if row and row[0]:
            connection.execute("DELETE FROM rag_staged_chunks WHERE job_id=%s", (job_id,))

    @staticmethod
    def _to_view(row) -> IndexingJobView:
        embedding_index_id = row[10] if len(row) > 10 else None
        embedding_index_name = row[11] if len(row) > 11 else None
        job_type = row[12] if len(row) > 12 else "incremental"
        return IndexingJobView(
            job_id=row[0], session_id=row[1], status=row[2], total_messages=row[3],
            processed_messages=row[4], stored_chunks=row[5], last_error=row[6],
            started_at=row[7], finished_at=row[8],
            embedding_index_id=embedding_index_id,
            embedding_index_name=embedding_index_name,
            job_type=job_type or "incremental",
        )
