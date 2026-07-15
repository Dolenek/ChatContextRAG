from contextlib import asynccontextmanager
from dataclasses import dataclass
from inspect import isawaitable
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from backend.api_security import InternalApiSecurityMiddleware
from backend.api_security import require_internal_token
from backend.chat_routes import register_chat_routes
from backend.chat_scope_catalog import PostgresChatScopeCatalog
from backend.chat_sessions import ChatSessionNotFoundError, PostgresChatSessionRepository
from backend.chunking import ConversationAwareChunker
from backend.database_routes import register_database_routes
from backend.discord_bot_repository import DiscordBotRepository
from backend.discord_bot_routes import register_discord_bot_routes
from backend.discord_bot_service import DiscordBotService
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
from backend.read_models import (
    PostgresReadModelReader, PostgresReadModelRefresher,
    PostgresReadModelStore, ReadModelRefreshWorker,
)
from backend.services import DatabaseChatService, DatabaseOverviewService, MessageIngestionService
from backend.settings import ApplicationSettings
from backend.settings_routes import register_settings_routes
from backend.settings_service import ApplicationSettingsService
from backend.source_context import SourceContextProjector
from backend.whatsapp_import import WhatsAppImportCoordinator
from backend.workspace_settings import PostgresWorkspaceSettingsRepository


@dataclass(frozen=True)
class RuntimeStorage:
    raw_repository: PostgresRawMessageRepository
    vector_repository: PostgresVectorRepository
    read_model_store: PostgresReadModelStore
    read_model_reader: PostgresReadModelReader
    read_model_worker: ReadModelRefreshWorker
    provider_registry: ProviderRegistry
    index_repository: PostgresEmbeddingIndexRepository
    hybrid_repository: PostgresHybridRepository
    indexing_worker: PersistentIndexingWorker


def create_app(
    ingestion_service: Optional[MessageIngestionService] = None,
    chat_service: Optional[DatabaseChatService] = None,
    overview_service: Optional[DatabaseOverviewService] = None,
    settings_service: Optional[ApplicationSettingsService] = None,
    migration_export_service: Optional[MigrationExportService] = None,
    discord_bot_service: Optional[DiscordBotService] = None,
    internal_token: Optional[str] = None,
) -> FastAPI:
    services = _resolve_services(
        ingestion_service, chat_service, overview_service, settings_service,
        discord_bot_service, internal_token,
    )
    active_ingestion, active_chat, active_overview, active_settings, active_discord, token = services
    application = FastAPI(
        title="Chat Context RAG API", version="0.5.0",
        lifespan=_background_service_lifespan(active_overview),
    )
    application.add_middleware(InternalApiSecurityMiddleware, internal_token=token)
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
    if active_discord:
        register_discord_bot_routes(application, active_discord)
    return application


def _background_service_lifespan(overview_service):
    @asynccontextmanager
    async def lifespan(_application: FastAPI):
        start_services = getattr(overview_service, "start_background_services", None)
        stop_services = getattr(overview_service, "close_background_services", None)
        await _run_lifecycle_hook(start_services)
        try:
            yield
        finally:
            await _run_lifecycle_hook(stop_services)

    return lifespan


async def _run_lifecycle_hook(hook) -> None:
    if not hook:
        return
    result = hook()
    if isawaitable(result):
        await result


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
    discord_bot_service, internal_token,
) -> tuple:
    if ingestion_service and chat_service and overview_service:
        token = require_internal_token(internal_token)
        return (
            ingestion_service, chat_service, overview_service, settings_service,
            discord_bot_service, token,
        )
    return _build_default_services()


def _migration_exports(ingestion_service) -> Optional[MigrationExportService]:
    repository = getattr(ingestion_service, "raw_repository", None)
    if not repository:
        return None
    return MigrationExportService(repository.ensure_schema, repository.open_connection)


def _build_default_services() -> tuple:
    settings = ApplicationSettings.from_environment()
    storage = _build_storage(settings)
    raw_repository = storage.raw_repository
    embedding_provider = OpenAIEmbeddingProvider(
        settings.openai_api_key, settings.embedding_model, settings.embedding_dimensions,
        settings.embedding_batch_size,
    )
    chat_provider = OpenAIChatCompletionProvider(settings.openai_api_key, settings.chat_model)
    ingestion = _build_ingestion_service(storage)
    workspace_settings = PostgresWorkspaceSettingsRepository(
        raw_repository.ensure_schema, raw_repository.open_connection,
    )
    chat = _build_default_chat(
        settings, storage.vector_repository, raw_repository, embedding_provider, chat_provider,
        storage.hybrid_repository, storage.provider_registry, storage.index_repository,
        workspace_settings, storage.read_model_reader,
    )
    overview = DatabaseOverviewService(
        storage.vector_repository, raw_repository, storage.read_model_store,
        storage.read_model_worker,
    )
    settings_service = ApplicationSettingsService(
        storage.provider_registry, storage.index_repository, storage.hybrid_repository,
        raw_repository, storage.indexing_worker, default_chat_model=settings.chat_model,
        workspace_settings=workspace_settings,
    )
    discord_bot = DiscordBotService(
        DiscordBotRepository(raw_repository.ensure_schema, raw_repository.open_connection),
        storage.provider_registry, storage.index_repository, storage.hybrid_repository,
        SourceContextProjector(raw_repository), raw_repository, workspace_settings,
    )
    return (
        ingestion, chat, overview, settings_service, discord_bot,
        settings.internal_token,
    )


def _build_ingestion_service(storage: RuntimeStorage) -> MessageIngestionService:
    return MessageIngestionService(
        SourceMessageNormalizer(), storage.raw_repository, storage.indexing_worker,
    )


def _build_storage(settings) -> RuntimeStorage:
    read_model_store = PostgresReadModelStore(settings.postgres_dsn)
    read_model_reader = PostgresReadModelReader(settings.postgres_dsn)
    raw_repository = PostgresRawMessageRepository(
        settings.postgres_dsn, settings.embedding_model, settings.embedding_dimensions,
        read_model_store,
    )
    raw_repository.ensure_schema()
    read_model_store.ensure_schema()
    read_model_worker = ReadModelRefreshWorker(
        read_model_store, PostgresReadModelRefresher(settings.postgres_dsn),
    )
    repository = PostgresVectorRepository(
        settings.postgres_dsn, settings.embedding_dimensions,
        read_model_reader, read_model_store,
    )
    model_stack = _build_model_stack(settings, raw_repository, read_model_store)
    return RuntimeStorage(
        raw_repository, repository, read_model_store, read_model_reader,
        read_model_worker, *model_stack,
    )


def _build_default_chat(
    settings, repository, raw_repository, embedding_provider, chat_provider,
    hybrid_repository, provider_registry, index_repository, workspace_settings,
    read_model_reader,
) -> DatabaseChatService:
    return DatabaseChatService(
        repository, embedding_provider, chat_provider, hybrid_repository,
        PostgresChatScopeCatalog(settings.postgres_dsn, read_model_reader),
        provider_registry=provider_registry, index_repository=index_repository,
        default_chat_model=settings.chat_model,
        chat_session_repository=PostgresChatSessionRepository(
            raw_repository.ensure_schema, raw_repository.open_connection,
        ),
        source_context_projector=SourceContextProjector(raw_repository),
        archive_context_reader=raw_repository, workspace_settings=workspace_settings,
    )


def _build_model_stack(settings, raw_repository, read_model_store):
    provider_registry = ProviderRegistry(
        settings.openai_api_key, settings.embedding_batch_size,
    )
    index_repository = PostgresEmbeddingIndexRepository(
        settings.postgres_dsn, provider_registry, settings.embedding_model,
        settings.embedding_dimensions, read_model_store,
    )
    index_repository.ensure_schema()
    hybrid_repository = PostgresHybridRepository(
        settings.postgres_dsn, settings.embedding_dimensions, read_model_store,
    )
    hybrid_repository.ensure_schema()
    indexing_worker = PersistentIndexingWorker(
        raw_repository, hybrid_repository, ConversationAwareChunker(), None,
        settings.embedding_batch_size,
        provider_registry=provider_registry, index_repository=index_repository,
    )
    indexing_worker.start()
    return provider_registry, index_repository, hybrid_repository, indexing_worker
