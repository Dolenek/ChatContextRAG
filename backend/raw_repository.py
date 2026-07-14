import threading
import uuid
from typing import Dict, Iterator, List, Optional, Sequence

import psycopg

from backend.indexing_job_repository import PostgresIndexingJobRepository
from backend.chunk_context_repository import PostgresActiveChunkContextReader
from backend.models import (
    ChatSourceChunk, IndexingJobView, IngestionSessionRequest, IngestionSessionView,
    IntegrationSyncState, SourceConversationView,
)
from backend.openai_gateway import ExternalIntegrationError
from backend.pending_indexing import PostgresPendingIndexingJobCreator
from backend.raw_message_writer import RawMessageWriter
from backend.raw_schema import raw_schema_statements
from backend.vector_models import NormalizedMessage


class PostgresRawMessageRepository:
    def __init__(
        self, database_dsn: str,
        default_embedding_model: str = "text-embedding-3-small",
        default_embedding_dimensions: int = 1536,
    ) -> None:
        self.database_dsn = database_dsn
        self.default_embedding_model = default_embedding_model
        self.default_embedding_dimensions = default_embedding_dimensions
        self._initialized = False
        self._lock = threading.Lock()
        self.message_writer = RawMessageWriter()
        self.job_repository = PostgresIndexingJobRepository(self.ensure_schema, self._connect)
        self.pending_job_creator = PostgresPendingIndexingJobCreator(
            self.ensure_schema, self._connect,
        )
        self.chunk_context_reader = PostgresActiveChunkContextReader(
            self.ensure_schema, self._connect,
        )

    def create_session(self, request: IngestionSessionRequest) -> IngestionSessionView:
        self.ensure_schema()
        session_id = str(uuid.uuid4())
        try:
            with self._connect() as connection:
                connection.execute(
                    """INSERT INTO ingestion_sessions
                       (id,guild_id,channel_id,channel,source_type,conversation_id,
                        conversation_label,container_id,container_label,status)
                       VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,'running')""",
                    (
                        session_id, request.guild_id, request.channel_id, request.channel,
                        request.source_type, request.conversation_id or request.channel_id,
                        request.conversation_label or request.channel,
                        request.container_id or request.guild_id, request.container_label,
                    ),
                )
        except psycopg.Error as error:
            raise ExternalIntegrationError(
                "PostgreSQL ingestion session creation failed.",
            ) from error
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

    def finish_session(
        self, session_id: str, reason: str, queue_indexing: bool = True,
    ) -> IngestionSessionView:
        return self.job_repository.finish_session(session_id, reason, queue_indexing)

    def get_session(self, session_id: str) -> IngestionSessionView:
        return self.job_repository.get_session(session_id)

    def queue_session_indexing(self, session_id: str) -> IngestionSessionView:
        return self.job_repository.queue_session_indexing(session_id)

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

    def load_messages_by_ids(self, message_ids: Sequence[str]) -> List[NormalizedMessage]:
        ordered_ids = list(dict.fromkeys(message_ids))
        if not ordered_ids:
            return []
        self.ensure_schema()
        try:
            with self._connect() as connection:
                rows = connection.execute(
                    """SELECT m.external_id,m.author,c.content,m.sent_at,m.channel,
                              m.channel_id,m.guild_id,m.source_type,m.conversation_id,
                              m.conversation_label,m.container_id,m.container_label,
                              m.source_metadata,m.message_order
                       FROM source_messages m
                       JOIN message_contents c ON c.content_hash=m.content_hash
                       WHERE m.external_id=ANY(%s)""",
                    (ordered_ids,),
                ).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL source message read failed.") from error
        messages = {row[0]: NormalizedMessage(*row) for row in rows}
        return [messages[message_id] for message_id in ordered_ids if message_id in messages]

    def load_chunk_contexts_by_ids(
        self, message_ids: Sequence[str],
    ) -> Dict[str, ChatSourceChunk]:
        return self.chunk_context_reader.load(message_ids)

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
                    SELECT m.external_id,m.author,c.content,m.sent_at,m.channel,
                           m.channel_id,m.guild_id,m.source_type,m.conversation_id,
                           m.conversation_label,m.container_id,m.container_label,
                           m.source_metadata,m.message_order
                    FROM target_ids target
                    JOIN source_messages m ON m.external_id=target.message_id
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
        with self._connect() as connection:
            connection.execute("SET LOCAL work_mem='16MB'")
            cursor = connection.cursor(name=f"job_{job_id.replace('-', '')[:20]}")
            with cursor:
                yield from self._stream_job_messages(cursor, job_id, page_size)

    @staticmethod
    def _stream_job_messages(
        cursor, job_id: str, page_size: int,
    ) -> Iterator[NormalizedMessage]:
        cursor.itersize = page_size
        cursor.execute(
            """SELECT m.external_id,m.author,c.content,m.sent_at,m.channel,
                      m.channel_id,m.guild_id,m.source_type,m.conversation_id,
                      m.conversation_label,m.container_id,m.container_label,
                      m.source_metadata,m.message_order
               FROM indexing_job_messages jm
               JOIN source_messages m ON m.external_id=jm.message_id
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
                """SELECT external_id FROM source_messages
                   WHERE source_type='discord' AND
                     (channel_id=%s OR (channel_id IS NULL AND channel=%s))
                   ORDER BY message_order, external_id LIMIT 1""",
                (channel_id, channel_name),
            ).fetchone()
        return row[0] if row else None

    def list_conversations(self, source_type: str) -> List[SourceConversationView]:
        self.ensure_schema()
        with self._connect() as connection:
            rows = connection.execute(
                """SELECT source_type,conversation_id,
                          COALESCE(MAX(conversation_label),MAX(channel),'Unnamed conversation'),
                          COALESCE(MAX(container_label),MAX(container_id)),COUNT(*)
                   FROM source_messages WHERE source_type=%s
                     AND conversation_id IS NOT NULL
                   GROUP BY source_type,conversation_id
                   ORDER BY 3""", (source_type,),
            ).fetchall()
        return [SourceConversationView(
            source_type=row[0], conversation_id=row[1], display_name=row[2],
            container_name=row[3], message_count=row[4],
        ) for row in rows]

    def list_sync_states(self, source_type: str) -> List[IntegrationSyncState]:
        self.ensure_schema()
        with self._connect() as connection:
            rows = connection.execute(
                """WITH raw_counts AS (
                     SELECT source_type,conversation_id,COUNT(*) AS message_count
                     FROM source_messages WHERE source_type=%s
                     GROUP BY source_type,conversation_id),
                   indexed_counts AS (
                     SELECT message.source_type,message.conversation_id,
                            COUNT(DISTINCT link.message_id) AS message_count
                     FROM rag_chunk_messages link
                     JOIN rag_application_settings settings ON settings.id=1
                       AND settings.active_embedding_index_id=link.embedding_index_id
                     JOIN source_messages message ON message.external_id=link.message_id
                     WHERE message.source_type=%s
                     GROUP BY message.source_type,message.conversation_id)
                   SELECT state.source_type,state.conversation_id,state.container_id,
                          state.conversation_label,container_label,oldest_cursor,newest_cursor,
                          active_session_id,backfill_complete,tracking_enabled,last_error,
                          COALESCE(raw_counts.message_count,0),
                          COALESCE(indexed_counts.message_count,0)
                   FROM integration_sync_states state
                   LEFT JOIN raw_counts USING(source_type,conversation_id)
                   LEFT JOIN indexed_counts USING(source_type,conversation_id)
                   WHERE state.source_type=%s ORDER BY conversation_label""",
                (source_type, source_type, source_type),
            ).fetchall()
        return [IntegrationSyncState(
            source_type=row[0], conversation_id=row[1], container_id=row[2],
            conversation_label=row[3], container_label=row[4], oldest_cursor=row[5],
            newest_cursor=row[6], active_session_id=row[7], backfill_complete=row[8],
            tracking_enabled=row[9], last_error=row[10], raw_message_count=row[11],
            indexed_message_count=row[12],
        ) for row in rows]

    def upsert_sync_state(self, state: IntegrationSyncState) -> IntegrationSyncState:
        self.ensure_schema()
        with self._connect() as connection:
            row = connection.execute(
                """INSERT INTO integration_sync_states
                   (source_type,conversation_id,container_id,conversation_label,
                    container_label,oldest_cursor,newest_cursor,backfill_complete,
                    active_session_id,tracking_enabled,last_error,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
                   ON CONFLICT(source_type,conversation_id) DO UPDATE SET
                     container_id=EXCLUDED.container_id,
                     conversation_label=EXCLUDED.conversation_label,
                     container_label=EXCLUDED.container_label,
                     oldest_cursor=EXCLUDED.oldest_cursor,
                     newest_cursor=EXCLUDED.newest_cursor,
                     backfill_complete=EXCLUDED.backfill_complete,
                     active_session_id=EXCLUDED.active_session_id,
                     tracking_enabled=EXCLUDED.tracking_enabled,
                     last_error=EXCLUDED.last_error,updated_at=NOW()
                   RETURNING source_type,conversation_id,container_id,conversation_label,
                     container_label,oldest_cursor,newest_cursor,active_session_id,
                     backfill_complete,tracking_enabled,last_error""",
                (
                    state.source_type, state.conversation_id, state.container_id,
                    state.conversation_label, state.container_label, state.oldest_cursor,
                    state.newest_cursor, state.backfill_complete,
                    state.active_session_id, state.tracking_enabled, state.last_error,
                ),
            ).fetchone()
        return IntegrationSyncState(
            source_type=row[0], conversation_id=row[1], container_id=row[2],
            conversation_label=row[3], container_label=row[4], oldest_cursor=row[5],
            newest_cursor=row[6], active_session_id=row[7], backfill_complete=row[8],
            tracking_enabled=row[9], last_error=row[10],
            raw_message_count=state.raw_message_count,
            indexed_message_count=state.indexed_message_count,
        )

    def delete_all(self) -> tuple:
        self.ensure_schema()
        with self._connect() as connection:
            chunk_count = connection.execute("SELECT COUNT(*) FROM rag_chunks").fetchone()[0]
            message_count = connection.execute("SELECT COUNT(*) FROM source_messages").fetchone()[0]
            connection.execute("TRUNCATE rag_staged_chunk_messages, rag_staged_chunks, "
                               "rag_chunk_messages, rag_chunks, indexing_job_messages, indexing_jobs, "
                               "ingestion_session_messages, ingestion_sessions, "
                               "integration_sync_states, source_messages, message_contents CASCADE")
            connection.execute(
                "UPDATE embedding_indexes SET status='ready',last_error=NULL,updated_at=NOW()"
            )
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
            with psycopg.connect(self.database_dsn) as connection:
                connection.execute("SELECT pg_advisory_xact_lock(1812199000)")
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                for statement in statements:
                    connection.execute(statement)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw schema initialization failed.") from error

    def _schema_statements(self) -> List[str]:
        return raw_schema_statements(
            self.default_embedding_model, self.default_embedding_dimensions,
        )

    def _connect(self):
        return psycopg.connect(self.database_dsn)

    def open_connection(self):
        """Return a repository connection for collaborating persistence services."""
        return self._connect()
