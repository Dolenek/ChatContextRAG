from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.chunking import ConversationAwareChunker
from backend.models import (
    ChannelResumePoint, ChatRequest, ChatResponse, ClearDatabaseRequest,
    ClearDatabaseResponse, DatabaseOverview, FinishIngestionRequest, HealthResponse,
    ImportRequest, ImportResponse, IndexingJobView, IngestionSessionRequest,
    IngestionSessionView,
)
from backend.normalization import DiscordMessageNormalizer
from backend.openai_gateway import (
    ExternalIntegrationError,
    IntegrationConfigurationError,
    OpenAIChatCompletionProvider,
    OpenAIEmbeddingProvider,
)
from backend.postgres_repository import PostgresVectorRepository
from backend.hybrid_repository import PostgresHybridRepository
from backend.indexing_worker import PersistentIndexingWorker
from backend.raw_repository import PostgresRawMessageRepository
from backend.services import DatabaseChatService, DatabaseOverviewService, MessageIngestionService
from backend.settings import ApplicationSettings


def create_app(
    ingestion_service: Optional[MessageIngestionService] = None,
    chat_service: Optional[DatabaseChatService] = None,
    overview_service: Optional[DatabaseOverviewService] = None,
) -> FastAPI:
    application = FastAPI(title="Chat Context RAG API", version="0.3.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "file://"],
        allow_methods=["GET", "POST", "DELETE"],
        allow_headers=["*"],
    )
    active_ingestion, active_chat, active_overview = _resolve_services(
        ingestion_service, chat_service, overview_service
    )

    @application.exception_handler(ExternalIntegrationError)
    async def integration_error_handler(
        _request: Request, error: ExternalIntegrationError
    ) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(IntegrationConfigurationError)
    async def configuration_error_handler(
        _request: Request, error: IntegrationConfigurationError
    ) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(ValueError)
    async def value_error_handler(_request: Request, error: ValueError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @application.post("/messages/import", response_model=ImportResponse)
    def import_messages(request: ImportRequest) -> ImportResponse:
        return active_ingestion.ingest(request)

    @application.post("/ingestion/sessions", response_model=IngestionSessionView)
    def create_ingestion_session(request: IngestionSessionRequest) -> IngestionSessionView:
        return active_ingestion.create_session(request)

    @application.post(
        "/ingestion/sessions/{session_id}/finish", response_model=IngestionSessionView,
    )
    def finish_ingestion_session(
        session_id: str, request: FinishIngestionRequest,
    ) -> IngestionSessionView:
        return active_ingestion.finish_session(session_id, request)

    @application.get("/indexing/jobs/{job_id}", response_model=IndexingJobView)
    def indexing_job(job_id: str) -> IndexingJobView:
        return active_ingestion.get_job(job_id)

    @application.post("/indexing/jobs/{job_id}/retry", response_model=IndexingJobView)
    def retry_indexing_job(job_id: str) -> IndexingJobView:
        return active_ingestion.retry_job(job_id)

    @application.post("/indexing/jobs/{job_id}/cancel", response_model=IndexingJobView)
    def cancel_indexing_job(job_id: str) -> IndexingJobView:
        return active_ingestion.cancel_job(job_id)

    @application.post("/chat", response_model=ChatResponse)
    def chat(request: ChatRequest) -> ChatResponse:
        return active_chat.answer(request)

    @application.get("/database/overview", response_model=DatabaseOverview)
    def database_overview(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> DatabaseOverview:
        return active_overview.get_overview(limit, offset)

    @application.get("/database/resume-point", response_model=ChannelResumePoint)
    def database_resume_point(
        channel_id: str = Query(min_length=1, max_length=128),
        channel: Optional[str] = Query(default=None, max_length=300),
    ) -> ChannelResumePoint:
        return active_overview.get_resume_point(channel_id, channel)

    @application.delete("/database", response_model=ClearDatabaseResponse)
    def clear_database(_request: ClearDatabaseRequest) -> ClearDatabaseResponse:
        result = active_overview.clear_database()
        if isinstance(result, tuple):
            return ClearDatabaseResponse(
                deleted_chunks=result[0], deleted_messages=result[1],
            )
        return ClearDatabaseResponse(deleted_chunks=result)

    return application


def _resolve_services(
    ingestion_service: Optional[MessageIngestionService],
    chat_service: Optional[DatabaseChatService],
    overview_service: Optional[DatabaseOverviewService],
) -> tuple:
    if ingestion_service and chat_service and overview_service:
        return ingestion_service, chat_service, overview_service
    return _build_default_services()


def _build_default_services() -> tuple:
    settings = ApplicationSettings.from_environment()
    api_key = settings.openai_api_key
    repository = PostgresVectorRepository(settings.postgres_dsn, settings.embedding_dimensions)
    raw_repository = PostgresRawMessageRepository(settings.postgres_dsn)
    raw_repository.ensure_schema()
    hybrid_repository = PostgresHybridRepository(
        settings.postgres_dsn, settings.embedding_dimensions,
    )
    hybrid_repository.ensure_schema()
    embedding_provider = OpenAIEmbeddingProvider(
        api_key, settings.embedding_model, settings.embedding_dimensions,
        settings.embedding_batch_size,
    )
    chat_provider = OpenAIChatCompletionProvider(api_key, settings.chat_model)
    indexing_worker = PersistentIndexingWorker(
        raw_repository, hybrid_repository, ConversationAwareChunker(), embedding_provider,
        settings.embedding_batch_size,
    )
    indexing_worker.start()
    ingestion = MessageIngestionService(
        DiscordMessageNormalizer(), raw_repository, indexing_worker,
    )
    chat = DatabaseChatService(
        repository, embedding_provider, chat_provider, hybrid_repository,
    )
    return ingestion, chat, DatabaseOverviewService(repository, raw_repository)


app = create_app()
