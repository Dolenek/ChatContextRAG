import threading
from dataclasses import dataclass
from typing import List, Optional

import psycopg

from backend.models import EmbeddingIndexCreate, EmbeddingIndexUpdate, EmbeddingIndexView
from backend.openai_gateway import ExternalIntegrationError
from backend.provider_registry import ProviderRegistry
from backend.embedding_index_support import (
    DEFAULT_INDEX_ID, assert_no_active_job, create_index_tables,
    embedding_index_view, index_view_sql, migrate_index_jobs,
    queue_all_messages, queue_messages, queue_missing_messages,
)


@dataclass(frozen=True)
class EmbeddingIndexConfiguration:
    embedding_index_id: str
    provider_id: str
    model: str
    dimensions: int
    requested_dimensions: Optional[int]


class PostgresEmbeddingIndexRepository:
    _migrate_jobs = staticmethod(migrate_index_jobs)
    _queue_all_messages = staticmethod(queue_all_messages)
    _queue_missing_messages = staticmethod(queue_missing_messages)
    _queue_messages = staticmethod(queue_messages)
    _assert_no_active_job = staticmethod(assert_no_active_job)
    _view_sql = staticmethod(index_view_sql)
    _to_view = staticmethod(embedding_index_view)
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
        create_index_tables(connection, self.default_model, self.default_dimensions)

    def _connect(self):
        return psycopg.connect(self.database_dsn)
