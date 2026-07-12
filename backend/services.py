from typing import List, Optional

from backend.models import (
    ChannelResumePoint, ChatRequest, ChatResponse, ChatSource, DatabaseOverview,
    FinishIngestionRequest, ImportRequest, ImportResponse, IndexingJobView,
    IngestionSessionRequest, IngestionSessionView,
)
from backend.normalization import DiscordMessageNormalizer
from backend.openai_gateway import ChatCompletionProvider, EmbeddingProvider
from backend.hybrid_repository import PostgresHybridRepository
from backend.indexing_worker import PersistentIndexingWorker
from backend.raw_repository import PostgresRawMessageRepository
from backend.repository import VectorRepository
from backend.vector_models import RetrievedChunk


class MessageIngestionService:
    def __init__(
        self,
        normalizer: DiscordMessageNormalizer,
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
        result = self.raw_repository.finish_session(session_id, request.reason)
        self.indexing_worker.wake()
        return result

    def get_job(self, job_id: str) -> IndexingJobView:
        return self.raw_repository.get_job(job_id)

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

    def _resolve_session(self, request, messages) -> tuple:
        if request.session_id:
            return request.session_id, False
        first = messages[0]
        session = self.create_session(IngestionSessionRequest(
            guild_id=first.guild_id or "unknown",
            channel_id=first.channel_id or "unknown",
            channel=first.channel,
        ))
        return session.session_id, True


class DatabaseChatService:
    def __init__(
        self,
        repository: VectorRepository,
        embedding_provider: EmbeddingProvider,
        chat_provider: ChatCompletionProvider,
        hybrid_repository: Optional[PostgresHybridRepository] = None,
        retrieval_limit: int = 8,
    ) -> None:
        self.repository = repository
        self.embedding_provider = embedding_provider
        self.chat_provider = chat_provider
        self.hybrid_repository = hybrid_repository
        self.retrieval_limit = retrieval_limit

    def answer(self, request: ChatRequest) -> ChatResponse:
        query_embedding = self.embedding_provider.embed_texts([request.question])[0]
        retrieved_chunks = self._retrieve(request.question, query_embedding)
        answer = self.chat_provider.answer(request.question, request.history, retrieved_chunks)
        return ChatResponse(answer=answer, sources=self._to_sources(retrieved_chunks))

    def _retrieve(self, question: str, query_embedding: List[float]) -> List[RetrievedChunk]:
        if self.hybrid_repository:
            hybrid_chunks = self.hybrid_repository.search_hybrid(
                question, query_embedding, self.retrieval_limit,
            )
            if hybrid_chunks:
                return hybrid_chunks
        return self.repository.search_similar(query_embedding, self.retrieval_limit)

    @staticmethod
    def _to_sources(chunks: List[RetrievedChunk]) -> List[ChatSource]:
        return [
            ChatSource(
                author=", ".join(chunk.authors), content=chunk.content,
                timestamp=chunk.started_at, channel=chunk.channel,
                similarity_score=chunk.similarity_score,
                source_message_ids=chunk.source_message_ids,
                channel_id=chunk.channel_id, guild_id=chunk.guild_id,
            )
            for chunk in chunks
        ]


class DatabaseOverviewService:
    def __init__(
        self, repository: VectorRepository,
        raw_repository: Optional[PostgresRawMessageRepository] = None,
    ) -> None:
        self.repository = repository
        self.raw_repository = raw_repository

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        return self.repository.get_overview(limit, offset)

    def clear_database(self) -> tuple:
        deleted_chunks = self.repository.delete_all()
        deleted_messages = 0
        if self.raw_repository:
            raw_chunks, deleted_messages = self.raw_repository.delete_all()
            deleted_chunks += raw_chunks
        return deleted_chunks, deleted_messages

    def get_resume_point(
        self, channel_id: str, channel_name: Optional[str]
    ) -> ChannelResumePoint:
        message_id = self.raw_repository.find_oldest_message_id(
            channel_id, channel_name,
        ) if self.raw_repository else None
        if not message_id:
            message_id = self.repository.find_oldest_source_message_id(channel_id, channel_name)
        return ChannelResumePoint(
            message_id=message_id, channel_id=channel_id, channel=channel_name,
        )
