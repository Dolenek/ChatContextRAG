import hashlib
import threading
import uuid
from datetime import datetime
from typing import Iterable, Iterator, List, Optional, Sequence

import psycopg

from backend.models import IndexingJobView, IngestionSessionRequest, IngestionSessionView
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import NormalizedMessage


class PostgresRawMessageRepository:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn
        self._initialized = False
        self._lock = threading.Lock()

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
                self._assert_running_session(connection, session_id)
                existing_ids = self._existing_ids(connection, messages)
                existing_hashes = self._existing_hashes(connection, messages)
                affected_hashes = self._upsert_contents(connection, messages)
                self._upsert_messages(connection, messages)
                self._link_session_messages(connection, session_id, messages)
                self._refresh_occurrence_counts(connection, affected_hashes)
                self._refresh_session_count(connection, session_id)
            new_count = len(messages) - len(existing_ids)
            unique_count = len(affected_hashes - existing_hashes)
            return new_count, unique_count
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw message write failed.") from error

    def finish_session(self, session_id: str, reason: str) -> IngestionSessionView:
        self.ensure_schema()
        job_id = str(uuid.uuid4())
        try:
            with self._connect() as connection:
                row = connection.execute(
                    """UPDATE ingestion_sessions SET status=%s, finished_at=NOW()
                       WHERE id=%s RETURNING raw_message_count""",
                    (reason, session_id),
                ).fetchone()
                if not row:
                    raise ValueError("Ingestion session was not found.")
                connection.execute(
                    """INSERT INTO indexing_jobs
                       (id, session_id, status, total_messages)
                       VALUES (%s, %s, 'queued', %s)
                       ON CONFLICT (session_id) DO UPDATE SET status='queued',
                         last_error=NULL, finished_at=NULL
                       RETURNING id""",
                    (job_id, session_id, row[0]),
                )
                stored_job_id = connection.execute(
                    "SELECT id FROM indexing_jobs WHERE session_id=%s", (session_id,)
                ).fetchone()[0]
            return IngestionSessionView(
                session_id=session_id, status=reason, raw_message_count=row[0],
                indexing_job_id=stored_job_id,
            )
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL ingestion finalization failed.") from error

    def get_job(self, job_id: str) -> IndexingJobView:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(self._job_select_sql("id=%s"), (job_id,)).fetchone()
        if not row:
            raise ValueError("Indexing job was not found.")
        return self._to_job(row)

    def list_jobs(self, limit: int = 10) -> List[IndexingJobView]:
        self.ensure_schema()
        with self._connect() as connection:
            rows = connection.execute(
                self._job_select_sql("TRUE") + " ORDER BY created_at DESC LIMIT %s", (limit,)
            ).fetchall()
        return [self._to_job(row) for row in rows]

    def retry_job(self, job_id: str) -> IndexingJobView:
        self._set_job_status(job_id, "queued")
        return self.get_job(job_id)

    def cancel_job(self, job_id: str) -> IndexingJobView:
        self._set_job_status(job_id, "cancelled")
        return self.get_job(job_id)

    def claim_next_job(self) -> Optional[IndexingJobView]:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(
                """SELECT id FROM indexing_jobs WHERE status='queued'
                   ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1"""
            ).fetchone()
            if not row:
                return None
            connection.execute(
                """UPDATE indexing_jobs SET status='running', started_at=COALESCE(started_at,NOW()),
                   last_error=NULL WHERE id=%s""", (row[0],)
            )
        return self.get_job(row[0])

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
        self, job_id: str, processed_messages: int, stored_chunks: int
    ) -> None:
        with self._connect() as connection:
            connection.execute(
                """UPDATE indexing_jobs SET processed_messages=%s, stored_chunks=%s
                   WHERE id=%s""", (processed_messages, stored_chunks, job_id),
            )

    def prepare_job_total(self, job_id: str, session_id: str) -> int:
        with self._connect() as connection:
            connection.execute("DELETE FROM indexing_job_messages WHERE job_id=%s", (job_id,))
            connection.execute(
                """INSERT INTO indexing_job_messages(job_id,message_id)
                   WITH session_ids AS (
                     SELECT message_id FROM ingestion_session_messages WHERE session_id=%s),
                   affected AS (SELECT chunk_id FROM rag_chunk_messages
                     WHERE message_id IN (SELECT message_id FROM session_ids)),
                   targets AS (SELECT message_id FROM session_ids UNION SELECT message_id
                     FROM rag_chunk_messages WHERE chunk_id IN (SELECT chunk_id FROM affected))
                   SELECT %s,message_id FROM targets ON CONFLICT DO NOTHING""",
                (session_id, job_id),
            )
            count = connection.execute(
                "SELECT COUNT(*) FROM indexing_job_messages WHERE job_id=%s", (job_id,),
            ).fetchone()[0]
            connection.execute(
                "UPDATE indexing_jobs SET total_messages=%s WHERE id=%s", (count, job_id),
            )
        return count

    def complete_job(self, job_id: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """UPDATE indexing_jobs SET status='completed', processed_messages=total_messages,
                   finished_at=NOW(), last_error=NULL WHERE id=%s""", (job_id,),
            )

    def fail_job(self, job_id: str, error: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """UPDATE indexing_jobs SET status='failed', last_error=%s,
                   finished_at=NOW() WHERE id=%s""", (error[:1000], job_id),
            )

    def reset_running_jobs(self) -> None:
        self.ensure_schema()
        with self._connect() as connection:
            connection.execute("UPDATE indexing_jobs SET status='queued' WHERE status='running'")

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
            connection.execute("TRUNCATE rag_chunk_messages, rag_chunks, indexing_job_messages, indexing_jobs, "
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

    def _schema_statements(self) -> List[str]:
        return [
            """CREATE TABLE IF NOT EXISTS message_contents (
                content_hash TEXT PRIMARY KEY, content TEXT NOT NULL,
                occurrence_count BIGINT NOT NULL DEFAULT 0,
                search_vector TSVECTOR GENERATED ALWAYS AS
                  (to_tsvector('simple', content)) STORED)""",
            """CREATE INDEX IF NOT EXISTS message_contents_search_gin
                ON message_contents USING gin(search_vector)""",
            """CREATE TABLE IF NOT EXISTS discord_messages (
                external_id TEXT PRIMARY KEY, message_order NUMERIC(20,0) NOT NULL,
                author TEXT NOT NULL, sent_at TIMESTAMPTZ, channel TEXT,
                channel_id TEXT, guild_id TEXT, content_hash TEXT NOT NULL
                  REFERENCES message_contents(content_hash), updated_at TIMESTAMPTZ DEFAULT NOW())""",
            """CREATE INDEX IF NOT EXISTS discord_messages_channel_order
                ON discord_messages(channel_id, message_order)""",
            """CREATE TABLE IF NOT EXISTS ingestion_sessions (
                id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
                channel TEXT, status TEXT NOT NULL, raw_message_count BIGINT DEFAULT 0,
                created_at TIMESTAMPTZ DEFAULT NOW(), finished_at TIMESTAMPTZ)""",
            """CREATE TABLE IF NOT EXISTS ingestion_session_messages (
                session_id TEXT REFERENCES ingestion_sessions(id) ON DELETE CASCADE,
                message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
                PRIMARY KEY(session_id,message_id))""",
            """CREATE TABLE IF NOT EXISTS indexing_jobs (
                id TEXT PRIMARY KEY, session_id TEXT UNIQUE REFERENCES ingestion_sessions(id),
                status TEXT NOT NULL, total_messages BIGINT DEFAULT 0,
                processed_messages BIGINT DEFAULT 0, stored_chunks BIGINT DEFAULT 0,
                last_error TEXT, created_at TIMESTAMPTZ DEFAULT NOW(),
                started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ)""",
            """CREATE TABLE IF NOT EXISTS indexing_job_messages (
                job_id TEXT REFERENCES indexing_jobs(id) ON DELETE CASCADE,
                message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
                PRIMARY KEY(job_id,message_id))""",
        ]

    def _upsert_contents(self, connection, messages) -> set:
        content_rows = {(self.content_hash(message.content), message.content) for message in messages}
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)
                   ON CONFLICT(content_hash) DO NOTHING""", list(content_rows),
            )
        return {row[0] for row in content_rows}

    def _upsert_messages(self, connection, messages) -> None:
        rows = [(
            message.external_id, self._message_order(message.external_id), message.author,
            message.timestamp, message.channel, message.channel_id, message.guild_id,
            self.content_hash(message.content),
        ) for message in messages]
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO discord_messages
                   (external_id,message_order,author,sent_at,channel,channel_id,guild_id,content_hash)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
                   ON CONFLICT(external_id) DO UPDATE SET author=EXCLUDED.author,
                     sent_at=EXCLUDED.sent_at, channel=EXCLUDED.channel,
                     channel_id=EXCLUDED.channel_id, guild_id=EXCLUDED.guild_id,
                     content_hash=EXCLUDED.content_hash, updated_at=NOW()""", rows,
            )

    def _link_session_messages(self, connection, session_id, messages) -> None:
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO ingestion_session_messages(session_id,message_id)
                   VALUES (%s,%s) ON CONFLICT DO NOTHING""",
                [(session_id, message.external_id) for message in messages],
            )

    def _refresh_occurrence_counts(self, connection, hashes: Iterable[str]) -> None:
        hash_list = list(hashes)
        connection.execute(
            """UPDATE message_contents c SET occurrence_count=(
                 SELECT COUNT(*) FROM discord_messages m WHERE m.content_hash=c.content_hash)
               WHERE c.content_hash=ANY(%s)""", (hash_list,),
        )

    @staticmethod
    def _refresh_session_count(connection, session_id: str) -> None:
        connection.execute(
            """UPDATE ingestion_sessions SET raw_message_count=(
                 SELECT COUNT(*) FROM ingestion_session_messages WHERE session_id=%s)
               WHERE id=%s""", (session_id, session_id),
        )

    @staticmethod
    def _existing_ids(connection, messages) -> set:
        ids = [message.external_id for message in messages]
        rows = connection.execute(
            "SELECT external_id FROM discord_messages WHERE external_id=ANY(%s)", (ids,),
        ).fetchall()
        return {row[0] for row in rows}

    def _existing_hashes(self, connection, messages) -> set:
        hashes = [self.content_hash(message.content) for message in messages]
        rows = connection.execute(
            "SELECT content_hash FROM message_contents WHERE content_hash=ANY(%s)", (hashes,),
        ).fetchall()
        return {row[0] for row in rows}

    @staticmethod
    def _assert_running_session(connection, session_id: str) -> None:
        row = connection.execute(
            "SELECT status FROM ingestion_sessions WHERE id=%s", (session_id,)
        ).fetchone()
        if not row or row[0] != "running":
            raise ValueError("Ingestion session is not running.")

    def _set_job_status(self, job_id: str, status: str) -> None:
        self.ensure_schema()
        with self._connect() as connection:
            connection.execute(
                """UPDATE indexing_jobs SET status=%s, last_error=NULL,
                   finished_at=CASE WHEN %s='cancelled' THEN NOW() ELSE NULL END
                   WHERE id=%s""", (status, status, job_id),
            )

    @staticmethod
    def _job_select_sql(condition: str) -> str:
        return f"""SELECT id,session_id,status,total_messages,processed_messages,
                   stored_chunks,last_error,started_at,finished_at,created_at
                   FROM indexing_jobs WHERE {condition}"""

    @staticmethod
    def _to_job(row) -> IndexingJobView:
        return IndexingJobView(
            job_id=row[0], session_id=row[1], status=row[2], total_messages=row[3],
            processed_messages=row[4], stored_chunks=row[5], last_error=row[6],
            started_at=row[7], finished_at=row[8],
        )

    @staticmethod
    def content_hash(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    @staticmethod
    def _message_order(external_id: str) -> int:
        return int(external_id) if external_id.isdigit() else 0

    def _connect(self):
        return psycopg.connect(self.database_dsn)
