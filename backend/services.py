from typing import Optional

from backend.chat_service import DatabaseChatService
from backend.indexing_worker import PersistentIndexingWorker
from backend.models import (
    ChannelResumePoint, DatabaseBreakdowns, DatabaseChunkPage, DatabaseCountPage,
    DatabaseOverview,
    DatabaseStatus, FinishIngestionRequest, ImportRequest, ImportResponse,
    IndexingJobView, IngestionSessionRequest, IngestionSessionView,
)
from backend.normalization import SourceMessageNormalizer
from backend.raw_repository import PostgresRawMessageRepository
from backend.repository import VectorRepository


class MessageIngestionService:
    def __init__(
        self, normalizer: SourceMessageNormalizer,
        raw_repository: PostgresRawMessageRepository,
        indexing_worker: PersistentIndexingWorker,
    ) -> None:
        self.normalizer = normalizer
        self.raw_repository = raw_repository
        self.indexing_worker = indexing_worker

    def ingest(self, request: ImportRequest) -> ImportResponse:
        normalized_messages = self.normalizer.normalize(request.messages)
        session_id, implicit = self._resolve_session(request, normalized_messages)
        stored_count, unique_count = self.raw_repository.store_messages(
            session_id, normalized_messages,
        )
        if implicit:
            self.raw_repository.finish_session(session_id, "completed")
            self.indexing_worker.wake()
        return ImportResponse(
            imported_count=stored_count, chunk_count=0, messages=request.messages,
            raw_stored_count=stored_count, unique_content_count=unique_count,
        )

    def create_session(self, request: IngestionSessionRequest) -> IngestionSessionView:
        return self.raw_repository.create_session(request)

    def finish_session(
        self, session_id: str, request: FinishIngestionRequest,
    ) -> IngestionSessionView:
        result = self.raw_repository.finish_session(
            session_id, request.reason, request.queue_indexing,
        )
        if result.indexing_job_ids:
            self.indexing_worker.wake()
        return result

    def get_session(self, session_id: str) -> IngestionSessionView:
        return self.raw_repository.get_session(session_id)

    def queue_session_indexing(self, session_id: str) -> IngestionSessionView:
        result = self.raw_repository.queue_session_indexing(session_id)
        if result.indexing_job_ids:
            self.indexing_worker.wake()
        return result

    def get_job(self, job_id: str) -> IndexingJobView:
        return self.raw_repository.get_job(job_id)

    def list_active_jobs(self) -> list[IndexingJobView]:
        return self.raw_repository.list_active_jobs()

    def retry_job(self, job_id: str) -> IndexingJobView:
        job = self.raw_repository.retry_job(job_id)
        self.indexing_worker.wake()
        return job

    def cancel_job(self, job_id: str) -> IndexingJobView:
        return self.raw_repository.cancel_job(job_id)

    def queue_pending_messages(self) -> IndexingJobView:
        job = self.raw_repository.queue_pending_messages()
        self.indexing_worker.wake()
        return job

    def list_conversations(self, source_type: str):
        return self.raw_repository.list_conversations(source_type)

    def list_sync_states(self, source_type: str):
        return self.raw_repository.list_sync_states(source_type)

    def upsert_sync_state(self, state):
        return self.raw_repository.upsert_sync_state(state)

    def _resolve_session(self, request, messages) -> tuple:
        if request.session_id:
            return request.session_id, False
        first = messages[0]
        session = self.create_session(IngestionSessionRequest(
            guild_id=first.guild_id, channel_id=first.channel_id,
            channel=first.channel, source_type=first.source_type,
            conversation_id=first.conversation_id or first.channel_id or "unknown",
            conversation_label=first.conversation_label or first.channel,
            container_id=first.container_id or first.guild_id,
            container_label=first.container_label,
        ))
        return session.session_id, True


class DatabaseOverviewService:
    def __init__(
        self, repository: VectorRepository,
        raw_repository: Optional[PostgresRawMessageRepository] = None,
    ) -> None:
        self.repository = repository
        self.raw_repository = raw_repository

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        return self.repository.get_overview(limit, offset)

    def get_status(self, fresh: bool = False) -> DatabaseStatus:
        return self.repository.get_database_status(fresh)

    def get_breakdowns(self) -> DatabaseBreakdowns:
        return self.repository.get_database_breakdowns()

    def get_breakdown_page(
        self, dimension: str, limit: int, offset: int,
    ) -> DatabaseCountPage:
        return self.repository.get_database_breakdown_page(dimension, limit, offset)

    def get_chunk_page(
        self, limit: int, cursor: Optional[str],
    ) -> DatabaseChunkPage:
        return self.repository.get_database_chunk_page(limit, cursor)

    def clear_database(self) -> tuple:
        deleted_chunks = self.repository.delete_all()
        deleted_messages = 0
        if self.raw_repository:
            raw_chunks, deleted_messages = self.raw_repository.delete_all()
            deleted_chunks += raw_chunks
        drop_cache = getattr(self.repository, "drop_database_status_cache", None)
        if drop_cache:
            drop_cache()
        return deleted_chunks, deleted_messages

    def warm_status_cache(self) -> None:
        warm_cache = getattr(self.repository, "warm_database_status_cache", None)
        if warm_cache:
            warm_cache()

    def close_status_cache(self) -> None:
        close_cache = getattr(self.repository, "close_database_status_cache", None)
        if close_cache:
            close_cache()

    def get_resume_point(
        self, channel_id: str, channel_name: Optional[str],
    ) -> ChannelResumePoint:
        message_id = self.raw_repository.find_oldest_message_id(
            channel_id, channel_name,
        ) if self.raw_repository else None
        if not message_id:
            message_id = self.repository.find_oldest_source_message_id(
                channel_id, channel_name,
            )
        return ChannelResumePoint(
            message_id=message_id, channel_id=channel_id, channel=channel_name,
        )
