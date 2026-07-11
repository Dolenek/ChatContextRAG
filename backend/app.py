from typing import Optional

from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.chunking import ConversationAwareChunker
from backend.models import (
    ChannelResumePoint, ChatRequest, ChatResponse, ClearDatabaseRequest,
    ClearDatabaseResponse, DatabaseOverview, HealthResponse, ImportRequest, ImportResponse,
)
from backend.normalization import DiscordMessageNormalizer
from backend.openai_gateway import (
    ExternalIntegrationError,
    IntegrationConfigurationError,
    OpenAIChatCompletionProvider,
    OpenAIEmbeddingProvider,
)
from backend.postgres_repository import PostgresVectorRepository
from backend.services import DatabaseChatService, DatabaseOverviewService, MessageIngestionService
from backend.settings import ApplicationSettings


def create_app(
    ingestion_service: Optional[MessageIngestionService] = None,
    chat_service: Optional[DatabaseChatService] = None,
    overview_service: Optional[DatabaseOverviewService] = None,
) -> FastAPI:
    application = FastAPI(title="Chat Context RAG API", version="0.2.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "file://"],
        allow_methods=["GET", "POST"],
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

    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @application.post("/messages/import", response_model=ImportResponse)
    def import_messages(request: ImportRequest) -> ImportResponse:
        return active_ingestion.ingest(request)

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
        deleted_chunks = active_overview.clear_database()
        return ClearDatabaseResponse(deleted_chunks=deleted_chunks)

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
    embedding_provider = OpenAIEmbeddingProvider(
        api_key, settings.embedding_model, settings.embedding_dimensions,
        settings.embedding_batch_size,
    )
    chat_provider = OpenAIChatCompletionProvider(api_key, settings.chat_model)
    ingestion = MessageIngestionService(
        DiscordMessageNormalizer(), ConversationAwareChunker(), embedding_provider, repository,
    )
    chat = DatabaseChatService(repository, embedding_provider, chat_provider)
    return ingestion, chat, DatabaseOverviewService(repository)


app = create_app()
