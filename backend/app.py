from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.chunking import ConversationAwareChunker
from backend.models import ChatRequest, ChatResponse, HealthResponse, ImportRequest, ImportResponse
from backend.normalization import DiscordMessageNormalizer
from backend.openai_gateway import (
    ExternalIntegrationError,
    IntegrationConfigurationError,
    OpenAIChatCompletionProvider,
    OpenAIEmbeddingProvider,
)
from backend.postgres_repository import PostgresVectorRepository
from backend.services import DatabaseChatService, MessageIngestionService
from backend.settings import ApplicationSettings


def create_app(
    ingestion_service: Optional[MessageIngestionService] = None,
    chat_service: Optional[DatabaseChatService] = None,
) -> FastAPI:
    application = FastAPI(title="Chat Context RAG API", version="0.2.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "file://"],
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )
    active_ingestion, active_chat = _resolve_services(ingestion_service, chat_service)

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

    return application


def _resolve_services(
    ingestion_service: Optional[MessageIngestionService],
    chat_service: Optional[DatabaseChatService],
) -> tuple:
    if ingestion_service and chat_service:
        return ingestion_service, chat_service
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
    return ingestion, DatabaseChatService(repository, embedding_provider, chat_provider)


app = create_app()
