from typing import Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.chat_routes import register_chat_routes
from backend.chat_scope_catalog import PostgresChatScopeCatalog
from backend.chat_sessions import ChatSessionNotFoundError, PostgresChatSessionRepository
from backend.chunking import ConversationAwareChunker
from backend.database_routes import register_database_routes
from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.hybrid_repository import PostgresHybridRepository
from backend.indexing_worker import PersistentIndexingWorker
from backend.ingestion_routes import _read_import_file, register_ingestion_routes
from backend.migration_exports import (
    MigrationExportService, register_migration_export_routes,
)
from backend.normalization import SourceMessageNormalizer
from backend.openai_gateway import (
    ExternalIntegrationError, IntegrationConfigurationError,
    OpenAIChatCompletionProvider, OpenAIEmbeddingProvider,
)
from backend.postgres_repository import PostgresVectorRepository
from backend.provider_registry import ProviderRegistry
from backend.raw_repository import PostgresRawMessageRepository
from backend.services import DatabaseChatService, DatabaseOverviewService, MessageIngestionService
from backend.settings import ApplicationSettings
from backend.settings_routes import register_settings_routes
from backend.settings_service import ApplicationSettingsService
from backend.source_context import SourceContextProjector
from backend.whatsapp_import import WhatsAppImportCoordinator
from backend.workspace_settings import PostgresWorkspaceSettingsRepository


def create_app(
    ingestion_service: Optional[MessageIngestionService] = None,
    chat_service: Optional[DatabaseChatService] = None,
    overview_service: Optional[DatabaseOverviewService] = None,
    settings_service: Optional[ApplicationSettingsService] = None,
    migration_export_service: Optional[MigrationExportService] = None,
) -> FastAPI:
    application = FastAPI(title="Chat Context RAG API", version="0.4.0")
    application.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost", "file://"],
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
        allow_headers=["*"],
    )
    services = _resolve_services(
        ingestion_service, chat_service, overview_service, settings_service,
    )
    active_ingestion, active_chat, active_overview, active_settings, token = services
    _register_exception_handlers(application)
    register_ingestion_routes(
        application, active_ingestion, WhatsAppImportCoordinator(active_ingestion),
    )
    active_exports = migration_export_service or _migration_exports(active_ingestion)
    if active_exports:
        register_migration_export_routes(application, active_exports, token)
    register_chat_routes(application, active_chat)
    register_database_routes(application, active_overview)
    if active_settings:
        register_settings_routes(application, active_settings, token)
    return application


def _register_exception_handlers(application: FastAPI) -> None:
    @application.exception_handler(ExternalIntegrationError)
    async def integration_error_handler(
        _request: Request, error: ExternalIntegrationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(IntegrationConfigurationError)
    async def configuration_error_handler(
        _request: Request, error: IntegrationConfigurationError,
    ) -> JSONResponse:
        return JSONResponse(status_code=503, content={"detail": str(error)})

    @application.exception_handler(ValueError)
    async def value_error_handler(_request: Request, error: ValueError) -> JSONResponse:
        return JSONResponse(status_code=409, content={"detail": str(error)})

    @application.exception_handler(ChatSessionNotFoundError)
    async def chat_session_not_found_handler(
        _request: Request, error: ChatSessionNotFoundError,
    ) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(error)})


def _resolve_services(
    ingestion_service, chat_service, overview_service, settings_service,
) -> tuple:
    if ingestion_service and chat_service and overview_service:
        return ingestion_service, chat_service, overview_service, settings_service, None
    return _build_default_services()


def _migration_exports(ingestion_service) -> Optional[MigrationExportService]:
    repository = getattr(ingestion_service, "raw_repository", None)
    if not repository:
        return None
    return MigrationExportService(repository.ensure_schema, repository.open_connection)


def _build_default_services() -> tuple:
    settings = ApplicationSettings.from_environment()
    repository = PostgresVectorRepository(settings.postgres_dsn, settings.embedding_dimensions)
    raw_repository = PostgresRawMessageRepository(
        settings.postgres_dsn, settings.embedding_model, settings.embedding_dimensions,
    )
    raw_repository.ensure_schema()
    model_stack = _build_model_stack(settings, raw_repository)
    provider_registry, index_repository, hybrid_repository, indexing_worker = model_stack
    embedding_provider = OpenAIEmbeddingProvider(
        settings.openai_api_key, settings.embedding_model, settings.embedding_dimensions,
        settings.embedding_batch_size,
    )
    chat_provider = OpenAIChatCompletionProvider(settings.openai_api_key, settings.chat_model)
    ingestion = MessageIngestionService(SourceMessageNormalizer(), raw_repository, indexing_worker)
    workspace_settings = PostgresWorkspaceSettingsRepository(
        raw_repository.ensure_schema, raw_repository.open_connection,
    )
    chat = _build_default_chat(
        settings, repository, raw_repository, embedding_provider, chat_provider,
        hybrid_repository, provider_registry, index_repository, workspace_settings,
    )
    overview = DatabaseOverviewService(repository, raw_repository)
    settings_service = ApplicationSettingsService(
        provider_registry, index_repository, hybrid_repository, raw_repository,
        indexing_worker, default_chat_model=settings.chat_model,
        workspace_settings=workspace_settings,
    )
    return ingestion, chat, overview, settings_service, settings.internal_token


def _build_default_chat(
    settings, repository, raw_repository, embedding_provider, chat_provider,
    hybrid_repository, provider_registry, index_repository, workspace_settings,
) -> DatabaseChatService:
    return DatabaseChatService(
        repository, embedding_provider, chat_provider, hybrid_repository,
        PostgresChatScopeCatalog(settings.postgres_dsn),
        provider_registry=provider_registry, index_repository=index_repository,
        default_chat_model=settings.chat_model,
        chat_session_repository=PostgresChatSessionRepository(
            raw_repository.ensure_schema, raw_repository.open_connection,
        ),
        source_context_projector=SourceContextProjector(raw_repository),
        archive_context_reader=raw_repository, workspace_settings=workspace_settings,
    )


def _build_model_stack(settings, raw_repository):
    provider_registry = ProviderRegistry(
        settings.openai_api_key, settings.embedding_batch_size,
    )
    index_repository = PostgresEmbeddingIndexRepository(
        settings.postgres_dsn, provider_registry, settings.embedding_model,
        settings.embedding_dimensions,
    )
    index_repository.ensure_schema()
    hybrid_repository = PostgresHybridRepository(
        settings.postgres_dsn, settings.embedding_dimensions,
    )
    hybrid_repository.ensure_schema()
    indexing_worker = PersistentIndexingWorker(
        raw_repository, hybrid_repository, ConversationAwareChunker(), None,
        settings.embedding_batch_size,
        provider_registry=provider_registry, index_repository=index_repository,
    )
    if not settings.internal_token:
        indexing_worker.start()
    return provider_registry, index_repository, hybrid_repository, indexing_worker


app = create_app()
