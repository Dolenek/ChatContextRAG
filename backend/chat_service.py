from typing import Callable, List, Optional

from backend.adaptive_chat import AdaptiveChatOrchestrator
from backend.archive_time import ArchiveTimeRange
from backend.archive_tools import ArchiveContextReader, ScopedArchiveTools
from backend.chat_models import (
    ChatRequest, ChatResponse, ChatScope, ChatScopeList, ChatSessionDetail,
    ChatSessionSummary, ChatSource,
)
from backend.chat_source_projection import project_chat_sources
from backend.chat_scope_catalog import ChatScopeCatalog
from backend.chat_sessions import ChatSessionRepository
from backend.chat_session_access import ChatSessionAccess
from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.hybrid_repository import PostgresHybridRepository
from backend.openai_gateway import ChatProvider, EmbeddingProvider
from backend.provider_registry import ProviderRegistry
from backend.repository import VectorRepository
from backend.source_context import SourceContextProjector
from backend.vector_models import RetrievedChunk


class DatabaseChatService(ChatSessionAccess):
    def __init__(
        self, repository: VectorRepository, embedding_provider: EmbeddingProvider,
        chat_provider: ChatProvider,
        hybrid_repository: Optional[PostgresHybridRepository] = None,
        scope_catalog: Optional[ChatScopeCatalog] = None, retrieval_limit: int = 8,
        provider_registry: Optional[ProviderRegistry] = None,
        index_repository: Optional[PostgresEmbeddingIndexRepository] = None,
        default_chat_provider_id: str = "openai",
        default_chat_model: Optional[str] = None,
        chat_session_repository: Optional[ChatSessionRepository] = None,
        source_context_projector: Optional[SourceContextProjector] = None,
        archive_context_reader: Optional[ArchiveContextReader] = None,
        workspace_settings=None,
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
        self.archive_context_reader = archive_context_reader
        self.workspace_settings = workspace_settings

    def list_scopes(self) -> ChatScopeList:
        scopes = self.scope_catalog.list_scopes() if self.scope_catalog else []
        return ChatScopeList(scopes=scopes)

    def answer(self, request: ChatRequest, activity_callback=None) -> ChatResponse:
        if self.provider_registry and self.index_repository:
            response = self._answer_with_selected_models(request, activity_callback)
        else:
            response = self._answer_with_default_models(request, activity_callback)
        return self._store_answer(request, response)

    def _answer_with_default_models(
        self, request: ChatRequest, activity_callback=None,
    ) -> ChatResponse:
        provider_id = request.chat_provider_id or self.default_chat_provider_id
        model = request.chat_model or self.default_chat_model
        if request.retrieval_mode == "adaptive":
            search = lambda query, deadline, time_range=None: self._default_search(
                query, request.scope, deadline, time_range,
            )
            return self._adaptive_response(
                request, self.chat_provider, search, provider_id, model, None,
                activity_callback,
            )
        embedding = self.embedding_provider.embed_texts([request.question])[0]
        chunks = self._retrieve(request.question, embedding, request.scope)
        answer = self.chat_provider.answer(
            request.question, request.history, chunks, request.reasoning_effort,
        )
        return self._response(request, answer, chunks, provider_id, model, None)

    def _answer_with_selected_models(
        self, request: ChatRequest, activity_callback=None,
    ) -> ChatResponse:
        active_index = self.index_repository.active()
        if not active_index or active_index.status != "ready":
            raise ValueError("No ready embedding index is active.")
        embedding_provider = self.provider_registry.create_embedding_provider(
            active_index.provider_id, active_index.model,
            active_index.requested_dimensions,
        )
        provider_id = request.chat_provider_id or self.default_chat_provider_id
        model = request.chat_model or self.default_chat_model
        if not model:
            raise ValueError("No chat model is configured.")
        chat_provider = self.provider_registry.create_chat_provider(provider_id, model)
        if request.retrieval_mode == "adaptive":
            search = lambda query, deadline, time_range=None: self._selected_search(
                query, request.scope, embedding_provider, active_index, deadline,
                time_range,
            )
            return self._adaptive_response(
                request, chat_provider, search, provider_id, model,
                active_index.embedding_index_id,
                activity_callback,
            )
        embedding = embedding_provider.embed_texts([request.question])[0]
        chunks = self._selected_chunks(request.question, embedding, request.scope, active_index)
        answer = chat_provider.answer(
            request.question, request.history, chunks, request.reasoning_effort,
        )
        return self._response(
            request, answer, chunks, provider_id, model,
            active_index.embedding_index_id,
        )

    def _adaptive_response(
        self, request, chat_provider, search_chunks: Callable, provider_id,
        model, embedding_index_id, activity_callback=None,
    ) -> ChatResponse:
        if not self.source_context_projector or not self.archive_context_reader:
            raise ValueError("Adaptive archive tools are not configured.")
        tools = ScopedArchiveTools(
            search_chunks, self.source_context_projector,
            self.archive_context_reader, request.scope,
        )
        orchestrator = AdaptiveChatOrchestrator(
            chat_provider, tools, self._workspace_timezone(), activity_callback,
        )
        answer, sources, activities = orchestrator.answer_with_activity(request)
        return ChatResponse(
            answer=answer, sources=sources, chat_provider_id=provider_id,
            chat_model=model, reasoning_effort=request.reasoning_effort,
            embedding_index_id=embedding_index_id, retrieval_mode="adaptive",
            evidence_character_limit=request.evidence_character_limit,
            tool_activity=activities,
        )

    def _response(
        self, request, answer, chunks, provider_id, model, embedding_index_id,
    ) -> ChatResponse:
        return ChatResponse(
            answer=answer, sources=self._project_sources(chunks),
            chat_provider_id=provider_id, chat_model=model,
            reasoning_effort=request.reasoning_effort,
            embedding_index_id=embedding_index_id,
            retrieval_mode="deterministic", evidence_character_limit=None,
        )

    def _default_search(
        self, query: str, scope: Optional[ChatScope], deadline: float,
        time_range: Optional[ArchiveTimeRange],
    ):
        embedding = self._adaptive_embedding(self.embedding_provider, query, deadline)
        return self._retrieve(query, embedding, scope, time_range)

    def _selected_search(
        self, query, scope, embedding_provider, active_index, deadline, time_range,
    ):
        embedding = self._adaptive_embedding(embedding_provider, query, deadline)
        return self._selected_chunks(query, embedding, scope, active_index, time_range)

    @staticmethod
    def _adaptive_embedding(provider, query, deadline):
        bounded_embed = getattr(provider, "embed_texts_before", None)
        embeddings = bounded_embed([query], deadline) if bounded_embed else (
            provider.embed_texts([query])
        )
        return embeddings[0]

    def _selected_chunks(
        self, query, embedding, scope, active_index, time_range=None,
    ):
        arguments = (
            query, embedding, self.retrieval_limit, scope,
            active_index.embedding_index_id, active_index.dimensions,
        )
        return self.hybrid_repository.search_hybrid(
            *arguments, time_range,
        ) if time_range else self.hybrid_repository.search_hybrid(*arguments)

    def _retrieve(
        self, question: str, query_embedding: List[float], scope: Optional[ChatScope],
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[RetrievedChunk]:
        if self.hybrid_repository:
            arguments = (question, query_embedding, self.retrieval_limit, scope)
            hybrid_chunks = self.hybrid_repository.search_hybrid(
                *arguments, time_range=time_range,
            ) if time_range else self.hybrid_repository.search_hybrid(*arguments)
            if hybrid_chunks:
                return hybrid_chunks
            if time_range:
                return []
        return self.repository.search_similar(
            query_embedding, self.retrieval_limit, scope,
        )

    def _workspace_timezone(self) -> str:
        return self.workspace_settings.get().timezone_name if self.workspace_settings else "UTC"

    def _project_sources(self, chunks: List[RetrievedChunk]) -> List[ChatSource]:
        return project_chat_sources(chunks, self.source_context_projector)

    @staticmethod
    def _to_sources(chunks: List[RetrievedChunk]) -> List[ChatSource]:
        return project_chat_sources(chunks, None)
