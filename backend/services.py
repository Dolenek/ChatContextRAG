from typing import List, Optional

from backend.models import (
    ChannelResumePoint, ChatRequest, ChatResponse, ChatScope, ChatScopeList,
    ChatSource, ChatSourceChunk, DatabaseOverview,
    FinishIngestionRequest, ImportRequest, ImportResponse, IndexingJobView,
    IngestionSessionRequest, IngestionSessionView,
)
from backend.chat_scope_catalog import ChatScopeCatalog
from backend.normalization import SourceMessageNormalizer
from backend.openai_gateway import ChatCompletionProvider, EmbeddingProvider
from backend.hybrid_repository import PostgresHybridRepository
from backend.indexing_worker import PersistentIndexingWorker
from backend.raw_repository import PostgresRawMessageRepository
from backend.source_context import SourceContextProjector
from backend.repository import VectorRepository
from backend.vector_models import RetrievedChunk
from backend.provider_registry import ProviderRegistry
from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.chat_sessions import ChatSessionRepository
from backend.models import ChatSessionDetail, ChatSessionSummary


class MessageIngestionService:
    def __init__(
        self,
        normalizer: SourceMessageNormalizer,
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
            guild_id=first.guild_id,
            channel_id=first.channel_id,
            channel=first.channel,
            source_type=first.source_type,
            conversation_id=first.conversation_id or first.channel_id or "unknown",
            conversation_label=first.conversation_label or first.channel,
            container_id=first.container_id or first.guild_id,
            container_label=first.container_label,
        ))
        return session.session_id, True


class DatabaseChatService:
    def __init__(
        self,
        repository: VectorRepository,
        embedding_provider: EmbeddingProvider,
        chat_provider: ChatCompletionProvider,
        hybrid_repository: Optional[PostgresHybridRepository] = None,
        scope_catalog: Optional[ChatScopeCatalog] = None,
        retrieval_limit: int = 8,
        provider_registry: Optional[ProviderRegistry] = None,
        index_repository: Optional[PostgresEmbeddingIndexRepository] = None,
        default_chat_provider_id: str = "openai",
        default_chat_model: Optional[str] = None,
        chat_session_repository: Optional[ChatSessionRepository] = None,
        source_context_projector: Optional[SourceContextProjector] = None,
    ) -> None:
        self.repository = repository
        self.embedding_provider = embedding_provider
        self.chat_provider = chat_provider
        self.hybrid_repository = hybrid_repository
        self.scope_catalog = scope_catalog
        self.retrieval_limit = retrieval_limit
        self.provider_registry = provider_registry
        self.index_repository = index_repository
        self.default_chat_provider_id = default_chat_provider_id
        self.default_chat_model = default_chat_model
        self.chat_session_repository = chat_session_repository
        self.source_context_projector = source_context_projector

    def list_scopes(self) -> ChatScopeList:
        scopes = self.scope_catalog.list_scopes() if self.scope_catalog else []
        return ChatScopeList(scopes=scopes)

    def answer(self, request: ChatRequest) -> ChatResponse:
        if self.provider_registry and self.index_repository:
            response = self._answer_with_selected_models(request)
        else:
            response = self._answer_with_default_models(request)
        return self._store_answer(request, response)

    def list_sessions(self, limit: int) -> List[ChatSessionSummary]:
        return self._sessions().list_recent(limit)

    def get_session(self, session_id: str) -> ChatSessionDetail:
        session = self._sessions().get(session_id)
        if not self.source_context_projector:
            return session
        messages = [
            message.model_copy(update={
                "sources": self.source_context_projector.expand_sources(message.sources),
            })
            for message in session.messages
        ]
        return session.model_copy(update={"messages": messages})

    def rename_session(self, session_id: str, title: str) -> ChatSessionSummary:
        return self._sessions().rename(session_id, title)

    def delete_session(self, session_id: str) -> None:
        self._sessions().delete(session_id)

    def _answer_with_default_models(self, request: ChatRequest) -> ChatResponse:
        query_embedding = self.embedding_provider.embed_texts([request.question])[0]
        retrieved_chunks = self._retrieve(request.question, query_embedding, request.scope)
        answer = self.chat_provider.answer(
            request.question, request.history, retrieved_chunks, request.reasoning_effort,
        )
        return ChatResponse(
            answer=answer, sources=self._project_sources(retrieved_chunks),
            chat_provider_id=request.chat_provider_id or self.default_chat_provider_id,
            chat_model=request.chat_model or self.default_chat_model,
            reasoning_effort=request.reasoning_effort,
        )

    def _answer_with_selected_models(self, request: ChatRequest) -> ChatResponse:
        active_index = self.index_repository.active()
        if not active_index or active_index.status != "ready":
            raise ValueError("No ready embedding index is active.")
        embedding_provider = self.provider_registry.create_embedding_provider(
            active_index.provider_id, active_index.model,
            active_index.requested_dimensions,
        )
        query_embedding = embedding_provider.embed_texts([request.question])[0]
        retrieved_chunks = self.hybrid_repository.search_hybrid(
            request.question, query_embedding, self.retrieval_limit, request.scope,
            active_index.embedding_index_id, active_index.dimensions,
        )
        provider_id = request.chat_provider_id or self.default_chat_provider_id
        model = request.chat_model or self.default_chat_model
        if not model:
            raise ValueError("No chat model is configured.")
        chat_provider = self.provider_registry.create_chat_provider(provider_id, model)
        answer = chat_provider.answer(
            request.question, request.history, retrieved_chunks, request.reasoning_effort,
        )
        return ChatResponse(
            answer=answer, sources=self._project_sources(retrieved_chunks),
            chat_provider_id=provider_id, chat_model=model,
            reasoning_effort=request.reasoning_effort,
            embedding_index_id=active_index.embedding_index_id,
        )

    def _retrieve(
        self, question: str, query_embedding: List[float], scope: Optional[ChatScope],
    ) -> List[RetrievedChunk]:
        if self.hybrid_repository:
            hybrid_chunks = self.hybrid_repository.search_hybrid(
                question, query_embedding, self.retrieval_limit, scope,
            )
            if hybrid_chunks:
                return hybrid_chunks
        return self.repository.search_similar(
            query_embedding, self.retrieval_limit, scope,
        )

    def _store_answer(self, request: ChatRequest, response: ChatResponse) -> ChatResponse:
        if not self.chat_session_repository:
            return response
        session = self.chat_session_repository.save_turn(request, response)
        return response.model_copy(update={
            "chat_session_id": session.session_id,
            "chat_session_title": session.title,
        })

    def _sessions(self) -> ChatSessionRepository:
        if not self.chat_session_repository:
            raise ValueError("Chat session storage is not configured.")
        return self.chat_session_repository

    def _project_sources(self, chunks: List[RetrievedChunk]) -> List[ChatSource]:
        if self.source_context_projector:
            return self.source_context_projector.project_chunks(chunks)
        return self._to_sources(chunks)

    @staticmethod
    def _to_sources(chunks: List[RetrievedChunk]) -> List[ChatSource]:
        sources = [
            ChatSource(
                author=", ".join(chunk.authors), content=chunk.content,
                timestamp=chunk.started_at, channel=chunk.channel,
                similarity_score=chunk.similarity_score,
                score_kind=(chunk.score_kind if chunk.score_kind in {"rrf", "cosine"}
                            else "unknown"),
                chunk=ChatSourceChunk(
                    chunk_id=chunk.chunk_id, content=chunk.content,
                    source_message_ids=chunk.source_message_ids, origin="retrieved",
                ),
                source_message_ids=chunk.source_message_ids,
                channel_id=chunk.channel_id, guild_id=chunk.guild_id,
                source_type=chunk.source_type,
                conversation_id=chunk.conversation_id,
            )
            for chunk in chunks
        ]
        return SourceContextProjector.normalize_match_scores(sources)


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
