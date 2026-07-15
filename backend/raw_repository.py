import threading
import uuid
from typing import Dict, Iterator, List, Optional, Sequence

import psycopg

from backend.archive_text_search import PostgresArchiveTextSearch
from backend.indexing_job_repository import PostgresIndexingJobRepository
from backend.integration_sync_repository import PostgresIntegrationSyncRepository
from backend.chunk_context_repository import PostgresActiveChunkContextReader
from backend.message_context_repository import PostgresMessageContextReader
from backend.models import (
    ChatScope, ChatSourceChunk, IngestionSessionRequest, IngestionSessionView,
    IntegrationSyncState, SourceConversationView,
)
from backend.openai_gateway import ExternalIntegrationError
from backend.pending_indexing import PostgresPendingIndexingJobCreator
from backend.raw_archive_reset import RawArchiveResetter
from backend.raw_message_writer import RawMessageWriter
from backend.raw_message_reader import PostgresRawMessageReader
from backend.raw_repository_jobs import RawRepositoryJobOperations
from backend.raw_schema import raw_schema_statements
from backend.read_models.store import PostgresReadModelStore
from backend.vector_models import NormalizedMessage


def _repository_schema_statements(model: str, dimensions: int) -> List[str]:
    return raw_schema_statements(model, dimensions)


class PostgresRawMessageRepository(RawRepositoryJobOperations):
    def __init__(
        self, database_dsn: str,
        default_embedding_model: str = "text-embedding-3-small",
        default_embedding_dimensions: int = 1536,
        read_model_store: Optional[PostgresReadModelStore] = None,
    ) -> None:
        self.database_dsn = database_dsn
        self.default_embedding_model = default_embedding_model
        self.default_embedding_dimensions = default_embedding_dimensions
        self.read_model_store = read_model_store
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
        self.message_context_reader = PostgresMessageContextReader(
            lambda: self.ensure_schema(), lambda: self._connect(),
        )
        self.message_reader = PostgresRawMessageReader(
            lambda: self.ensure_schema(), lambda: self._connect())
        self.archive_text_search = PostgresArchiveTextSearch(
            lambda: self.ensure_schema(), lambda: self._connect(),
        )
        self.sync_repository = PostgresIntegrationSyncRepository(
            lambda: self.ensure_schema(), lambda: self._connect(),
        )
        self.archive_resetter = RawArchiveResetter(
            self.ensure_schema, self._connect, read_model_store,
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
                result = self.message_writer.store_messages(connection, session_id, messages)
                if self.read_model_store:
                    self.read_model_store.invalidate_all(connection)
                return result
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw message write failed.") from error

    def load_session_messages(self, session_id: str) -> List[NormalizedMessage]:
        return list(self.iter_session_messages(session_id))

    def load_messages_by_ids(self, message_ids: Sequence[str]) -> List[NormalizedMessage]:
        return self.message_reader.load_by_ids(message_ids)

    def load_chunk_contexts_by_ids(
        self, message_ids: Sequence[str],
    ) -> Dict[str, ChatSourceChunk]:
        return self.chunk_context_reader.load(message_ids)

    def load_message_context(
        self, anchor_id: str, before_count: int, after_count: int,
        scope: Optional[ChatScope] = None,
        time_range=None,
    ) -> List[NormalizedMessage]:
        return self.message_context_reader.load(
            anchor_id, before_count, after_count, scope, time_range,
        )

    def search_text_occurrences(self, **arguments):
        return self.archive_text_search.search(**arguments)

    def iter_session_messages(
        self, session_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        return self.message_reader.iter_session(session_id, page_size)

    def iter_indexing_messages(
        self, job_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        return self.message_reader.iter_job(job_id, page_size)

    def find_oldest_message_id(
        self, channel_id: str, channel_name: Optional[str]
    ) -> Optional[str]:
        return self.message_reader.find_oldest_discord_id(channel_id, channel_name)

    def list_conversations(self, source_type: str) -> List[SourceConversationView]:
        return self.message_reader.list_conversations(source_type)

    def list_sync_states(self, source_type: str) -> List[IntegrationSyncState]:
        return self.sync_repository.list(source_type)

    def upsert_sync_state(self, state: IntegrationSyncState) -> IntegrationSyncState:
        return self.sync_repository.upsert(state)

    def delete_all(self) -> tuple:
        return self.archive_resetter.delete_all()

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
        statements = _repository_schema_statements(
            self.default_embedding_model, self.default_embedding_dimensions,
        )
        try:
            with psycopg.connect(self.database_dsn) as connection:
                connection.execute("SELECT pg_advisory_xact_lock(1812199000)")
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                for statement in statements:
                    connection.execute(statement)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL raw schema initialization failed.") from error

    def _connect(self):
        return psycopg.connect(self.database_dsn, connect_timeout=10)

    def open_connection(self):
        return self._connect()
