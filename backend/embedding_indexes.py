import logging
import threading
import uuid
from dataclasses import dataclass
from typing import List, Optional

import psycopg

from backend.models import EmbeddingIndexCreate, EmbeddingIndexUpdate, EmbeddingIndexView
from backend.openai_gateway import ExternalIntegrationError
from backend.provider_registry import ProviderRegistry


DEFAULT_INDEX_ID = "default-openai"
LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True)
class EmbeddingIndexConfiguration:
    embedding_index_id: str
    provider_id: str
    model: str
    dimensions: int
    requested_dimensions: Optional[int]


class PostgresEmbeddingIndexRepository:
    def __init__(
        self, database_dsn: str, registry: ProviderRegistry,
        default_model: str, default_dimensions: int,
    ) -> None:
        self.database_dsn = database_dsn
        self.registry = registry
        self.default_model = default_model
        self.default_dimensions = default_dimensions
        self._initialized = False
        self._lock = threading.Lock()

    def ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            try:
                with self._connect() as connection:
                    connection.execute("SELECT pg_advisory_xact_lock(1812199002)")
                    self._create_tables(connection)
                    self._migrate_jobs(connection)
            except psycopg.Error as error:
                raise ExternalIntegrationError(
                    "Embedding index schema initialization failed."
                ) from error
            self._initialized = True

    def create(self, request: EmbeddingIndexCreate) -> EmbeddingIndexView:
        self.ensure_schema()
        provider = self.registry.create_embedding_provider(
            request.provider_id, request.model, request.requested_dimensions,
        )
        vector = provider.embed_texts(["Chat Context embedding dimension probe."])[0]
        dimensions = len(vector)
        if request.requested_dimensions and dimensions != request.requested_dimensions:
            raise ValueError("Embedding provider returned a different vector dimension.")
        if not 1 <= dimensions <= 4000:
            raise ValueError("HNSW halfvec dimensions must be between 1 and 4000.")
        index_id = str(uuid.uuid4())
        with self._connect() as connection:
            connection.execute(
                """INSERT INTO embedding_indexes
                   (id,name,provider_id,model,dimensions,requested_dimensions,status,auto_sync)
                   VALUES (%s,%s,%s,%s,%s,%s,'building',%s)""",
                (
                    index_id, request.name, request.provider_id, request.model,
                    dimensions, request.requested_dimensions, request.auto_sync,
                ),
            )
            job_id = self._queue_all_messages(connection, index_id, "rebuild")
            if not job_id:
                connection.execute(
                    "UPDATE embedding_indexes SET status='ready',updated_at=NOW() WHERE id=%s",
                    (index_id,),
                )
        return self.get(index_id)

    def list(self) -> List[EmbeddingIndexView]:
        self.ensure_schema()
        with self._connect() as connection:
            rows = connection.execute(self._view_sql() + " ORDER BY idx.created_at").fetchall()
        return [self._to_view(row) for row in rows]

    def get(self, index_id: str) -> EmbeddingIndexView:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(
                self._view_sql() + " WHERE idx.id=%s", (index_id,),
            ).fetchone()
        if not row:
            raise ValueError("Embedding index was not found.")
        return self._to_view(row)

    def get_configuration(self, index_id: str) -> EmbeddingIndexConfiguration:
        view = self.get(index_id)
        return EmbeddingIndexConfiguration(
            view.embedding_index_id, view.provider_id, view.model,
            view.dimensions, view.requested_dimensions,
        )

    def active(self) -> Optional[EmbeddingIndexView]:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(
                "SELECT active_embedding_index_id FROM rag_application_settings WHERE id=1"
            ).fetchone()
        return self.get(row[0]) if row and row[0] else None

    def activate(self, index_id: str) -> EmbeddingIndexView:
        view = self.get(index_id)
        if view.status != "ready":
            raise ValueError("Only a ready embedding index can be activated.")
        with self._connect() as connection:
            connection.execute(
                "UPDATE rag_application_settings SET active_embedding_index_id=%s WHERE id=1",
                (index_id,),
            )
        return view

    def update(self, index_id: str, request: EmbeddingIndexUpdate) -> EmbeddingIndexView:
        self.get(index_id)
        with self._connect() as connection:
            connection.execute(
                """UPDATE embedding_indexes SET name=COALESCE(%s,name),
                   auto_sync=COALESCE(%s,auto_sync),updated_at=NOW() WHERE id=%s""",
                (request.name, request.auto_sync, index_id),
            )
        return self.get(index_id)

    def queue_sync(self, index_id: str) -> str:
        self.get(index_id)
        with self._connect() as connection:
            self._assert_no_active_job(connection, index_id)
            job_id = self._queue_missing_messages(connection, index_id)
        if not job_id:
            raise ValueError("No messages are waiting for this embedding index.")
        return job_id

    def queue_rebuild(self, index_id: str) -> Optional[str]:
        self.get(index_id)
        with self._connect() as connection:
            self._assert_no_active_job(connection, index_id)
            job_id = self._queue_all_messages(connection, index_id, "rebuild")
            if not job_id:
                connection.execute(
                    "DELETE FROM rag_chunks WHERE embedding_index_id=%s", (index_id,),
                )
            return job_id

    def delete(self, index_id: str) -> int:
        active = self.active()
        if active and active.embedding_index_id == index_id:
            raise ValueError("Select another active embedding index before deleting this one.")
        with self._connect() as connection:
            connection.execute(
                "UPDATE indexing_jobs SET status='cancelled',finished_at=NOW() "
                "WHERE embedding_index_id=%s AND status IN ('queued','running')", (index_id,),
            )
            count = connection.execute(
                "SELECT COUNT(*) FROM rag_chunks WHERE embedding_index_id=%s", (index_id,),
            ).fetchone()[0]
            connection.execute("DELETE FROM embedding_indexes WHERE id=%s", (index_id,))
        return count

    def provider_in_use(self, provider_id: str) -> bool:
        self.ensure_schema()
        with self._connect() as connection:
            return bool(connection.execute(
                "SELECT EXISTS(SELECT 1 FROM embedding_indexes WHERE provider_id=%s)",
                (provider_id,),
            ).fetchone()[0])

    def mark_failed(self, index_id: str, error: str) -> None:
        with self._connect() as connection:
            connection.execute(
                """UPDATE embedding_indexes SET status=CASE WHEN status='building'
                   THEN 'failed' ELSE status END,last_error=%s,updated_at=NOW() WHERE id=%s""",
                (error[:1000], index_id),
            )

    def mark_ready(self, index_id: str) -> None:
        with self._connect() as connection:
            previous = connection.execute(
                "SELECT status,auto_sync FROM embedding_indexes WHERE id=%s FOR UPDATE",
                (index_id,),
            ).fetchone()
            connection.execute(
                """UPDATE embedding_indexes SET status='ready',last_error=NULL,
                   updated_at=NOW() WHERE id=%s""",
                (index_id,),
            )
            if previous and previous[0] == "building" and previous[1]:
                self._queue_missing_messages(connection, index_id)

    def _create_tables(self, connection) -> None:
        connection.execute("""CREATE TABLE IF NOT EXISTS embedding_indexes (
            id TEXT PRIMARY KEY,name TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4000),
            requested_dimensions INTEGER,status TEXT NOT NULL,auto_sync BOOLEAN NOT NULL DEFAULT TRUE,
            last_error TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ DEFAULT NOW())""")
        connection.execute(
            """INSERT INTO embedding_indexes
               (id,name,provider_id,model,dimensions,requested_dimensions,status,auto_sync)
               VALUES (%s,'Default OpenAI index','openai',%s,%s,%s,'ready',TRUE)
               ON CONFLICT(id) DO NOTHING""",
            (DEFAULT_INDEX_ID, self.default_model, self.default_dimensions, self.default_dimensions),
        )
        connection.execute("""CREATE TABLE IF NOT EXISTS rag_application_settings (
            id INTEGER PRIMARY KEY CHECK(id=1),active_embedding_index_id TEXT
            REFERENCES embedding_indexes(id) ON DELETE SET NULL)""")
        connection.execute(
            "INSERT INTO rag_application_settings(id,active_embedding_index_id) VALUES(1,%s) "
            "ON CONFLICT(id) DO NOTHING", (DEFAULT_INDEX_ID,),
        )

    @staticmethod
    def _migrate_jobs(connection) -> None:
        connection.execute("ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS embedding_index_id TEXT")
        connection.execute("ALTER TABLE indexing_jobs ADD COLUMN IF NOT EXISTS job_type TEXT DEFAULT 'incremental'")
        connection.execute(
            "UPDATE indexing_jobs SET embedding_index_id=%s WHERE embedding_index_id IS NULL",
            (DEFAULT_INDEX_ID,),
        )
        connection.execute("ALTER TABLE indexing_jobs ALTER COLUMN embedding_index_id SET NOT NULL")
        connection.execute("ALTER TABLE indexing_jobs DROP CONSTRAINT IF EXISTS indexing_jobs_session_id_key")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_session_index_unique "
                           "ON indexing_jobs(session_id,embedding_index_id)")
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS indexing_jobs_active_sync_unique "
                           "ON indexing_jobs(embedding_index_id) WHERE job_type='sync' "
                           "AND status IN ('queued','running')")
        connection.execute("CREATE INDEX IF NOT EXISTS indexing_job_messages_message "
                           "ON indexing_job_messages(message_id,job_id)")
        connection.execute("""DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid='indexing_jobs'::regclass AND contype='f'
                AND pg_get_constraintdef(oid) LIKE 'FOREIGN KEY (embedding_index_id)%') THEN
              ALTER TABLE indexing_jobs ADD CONSTRAINT indexing_jobs_embedding_index_fkey
              FOREIGN KEY(embedding_index_id) REFERENCES embedding_indexes(id) ON DELETE CASCADE;
            END IF; END $$""")

    def _queue_all_messages(self, connection, index_id: str, job_type: str) -> Optional[str]:
        return self._queue_messages(connection, index_id, job_type, "TRUE")

    def _queue_missing_messages(self, connection, index_id: str) -> Optional[str]:
        condition = "NOT EXISTS (SELECT 1 FROM rag_chunk_messages link WHERE " \
                    "link.embedding_index_id=%s AND link.message_id=message.external_id) " \
                    "AND NOT EXISTS (SELECT 1 FROM ingestion_session_messages pending " \
                    "JOIN indexing_jobs job ON job.session_id=pending.session_id WHERE " \
                    "pending.message_id=message.external_id AND job.embedding_index_id=%s " \
                    "AND job.status IN ('queued','running'))"
        return self._queue_messages(
            connection, index_id, "sync", condition, (index_id, index_id),
        )

    @staticmethod
    def _queue_messages(
        connection, index_id: str, job_type: str, condition: str,
        condition_parameters: tuple = (),
    ) -> Optional[str]:
        session_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
        connection.execute("""INSERT INTO ingestion_sessions
            (id,source_type,conversation_id,conversation_label,status,finished_at)
            VALUES(%s,'maintenance',%s,'Embedding index maintenance','completed',NOW())""",
            (session_id, index_id))
        query = "INSERT INTO ingestion_session_messages(session_id,message_id) " \
                f"SELECT %s,message.external_id FROM source_messages message WHERE {condition}"
        inserted = connection.execute(query, (session_id, *condition_parameters)).rowcount
        if not inserted:
            connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (session_id,))
            return None
        connection.execute(
            "UPDATE ingestion_sessions SET raw_message_count=%s WHERE id=%s",
            (inserted, session_id),
        )
        connection.execute("""INSERT INTO indexing_jobs
            (id,session_id,embedding_index_id,job_type,status,total_messages)
            VALUES(%s,%s,%s,%s,'queued',%s)""",
            (job_id, session_id, index_id, job_type, inserted))
        LOGGER.info(
            "Indexing job queued: job_id=%s index_id=%s type=%s messages=%s",
            job_id, index_id, job_type, inserted,
        )
        return job_id

    @staticmethod
    def _assert_no_active_job(connection, index_id: str) -> None:
        active = connection.execute(
            """SELECT 1 FROM indexing_jobs WHERE embedding_index_id=%s
               AND status IN ('queued','running') LIMIT 1""", (index_id,),
        ).fetchone()
        if active:
            raise ValueError("This embedding index already has an active job.")

    @staticmethod
    def _view_sql() -> str:
        return """SELECT idx.id,idx.name,idx.provider_id,idx.model,idx.dimensions,
          idx.requested_dimensions,idx.status,idx.auto_sync,
          (SELECT COUNT(*) FROM rag_chunks chunk WHERE chunk.embedding_index_id=idx.id),
          (SELECT COUNT(*) FROM source_messages message WHERE NOT EXISTS
            (SELECT 1 FROM rag_chunk_messages link WHERE link.embedding_index_id=idx.id
             AND link.message_id=message.external_id)),idx.last_error,
          (SELECT job.id FROM indexing_jobs job WHERE job.embedding_index_id=idx.id
           AND job.status IN ('queued','running') ORDER BY job.created_at LIMIT 1),
          idx.created_at,idx.updated_at FROM embedding_indexes idx"""

    @staticmethod
    def _to_view(row) -> EmbeddingIndexView:
        return EmbeddingIndexView(
            embedding_index_id=row[0], name=row[1], provider_id=row[2], model=row[3],
            dimensions=row[4], requested_dimensions=row[5], status=row[6],
            auto_sync=row[7], chunk_count=row[8], pending_message_count=row[9],
            last_error=row[10], active_job_id=row[11], created_at=row[12], updated_at=row[13],
        )

    def _connect(self):
        return psycopg.connect(self.database_dsn)
