from typing import Optional

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from backend.chunking import ConversationAwareChunker
from backend.models import (
    ChannelResumePoint, ChatRequest, ChatResponse, ChatScopeList, ClearDatabaseRequest,
    ClearDatabaseResponse, DatabaseOverview, FinishIngestionRequest, HealthResponse,
    ImportRequest, ImportResponse, IndexingJobView, IngestionSessionRequest,
    IngestionSessionView, IntegrationSyncState, SourceConversationView, WhatsAppImportPreview,
    WhatsAppImportResponse, ChatSessionDetail, ChatSessionRename, ChatSessionSummary,
)
from backend.normalization import SourceMessageNormalizer
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
from backend.chat_scope_catalog import PostgresChatScopeCatalog
from backend.whatsapp_import import WhatsAppImportCoordinator
from backend.settings import ApplicationSettings
from backend.provider_registry import ProviderRegistry
from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.settings_routes import register_settings_routes
from backend.settings_service import ApplicationSettingsService
from backend.migration_exports import (
    MigrationExportService, register_migration_export_routes,
)
from backend.chat_sessions import ChatSessionNotFoundError, PostgresChatSessionRepository


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
    active_ingestion, active_chat, active_overview, active_settings, internal_token = _resolve_services(
        ingestion_service, chat_service, overview_service, settings_service,
    )
    _register_exception_handlers(application)
    _register_ingestion_routes(
        application, active_ingestion, WhatsAppImportCoordinator(active_ingestion),
    )
    active_exports = migration_export_service or _migration_exports(active_ingestion)
    if active_exports:
        register_migration_export_routes(application, active_exports, internal_token)
    _register_chat_routes(application, active_chat)
    _register_database_routes(application, active_overview)
    if active_settings:
        register_settings_routes(application, active_settings, internal_token)
    return application


def _register_exception_handlers(application: FastAPI) -> None:
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

    @application.exception_handler(ChatSessionNotFoundError)
    async def chat_session_not_found_handler(
        _request: Request, error: ChatSessionNotFoundError,
    ) -> JSONResponse:
        return JSONResponse(status_code=404, content={"detail": str(error)})


def _register_ingestion_routes(
    application: FastAPI, ingestion_service: MessageIngestionService,
    whatsapp_importer: WhatsAppImportCoordinator,
) -> None:
    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @application.post("/messages/import", response_model=ImportResponse)
    def import_messages(request: ImportRequest) -> ImportResponse:
        return ingestion_service.ingest(request)

    @application.get(
        "/ingestion/conversations", response_model=list[SourceConversationView],
    )
    def source_conversations(
        source_type: str = Query(pattern=r"^[a-z][a-z0-9_-]*$"),
    ) -> list[SourceConversationView]:
        return ingestion_service.list_conversations(source_type)

    @application.get(
        "/integrations/sync-states", response_model=list[IntegrationSyncState],
    )
    def integration_sync_states(
        source_type: str = Query(pattern=r"^[a-z][a-z0-9_-]*$"),
    ) -> list[IntegrationSyncState]:
        return ingestion_service.list_sync_states(source_type)

    @application.post(
        "/integrations/sync-state", response_model=IntegrationSyncState,
    )
    def update_integration_sync_state(
        state: IntegrationSyncState,
    ) -> IntegrationSyncState:
        return ingestion_service.upsert_sync_state(state)

    @application.post(
        "/imports/whatsapp/preview", response_model=WhatsAppImportPreview,
    )
    async def preview_whatsapp_import(
        export_file: UploadFile = File(),
        date_order: Optional[str] = Form(default=None),
        timezone_name: str = Form(default="UTC"),
        text_entry: Optional[str] = Form(default=None),
    ) -> WhatsAppImportPreview:
        payload = await _read_import_file(export_file)
        return whatsapp_importer.preview(
            payload, export_file.filename or "export.txt", date_order,
            timezone_name, text_entry,
        )

    @application.post(
        "/imports/whatsapp", response_model=WhatsAppImportResponse,
    )
    async def import_whatsapp_export(
        export_file: UploadFile = File(),
        conversation_id: str = Form(min_length=1, max_length=256),
        conversation_label: str = Form(min_length=1, max_length=300),
        date_order: Optional[str] = Form(default=None),
        timezone_name: str = Form(default="UTC"),
        text_entry: Optional[str] = Form(default=None),
    ) -> WhatsAppImportResponse:
        payload = await _read_import_file(export_file)
        return whatsapp_importer.import_export(
            payload, export_file.filename or "export.txt", conversation_id,
            conversation_label, date_order, timezone_name, text_entry,
        )

    @application.post("/ingestion/sessions", response_model=IngestionSessionView)
    def create_ingestion_session(request: IngestionSessionRequest) -> IngestionSessionView:
        return ingestion_service.create_session(request)

    @application.post(
        "/ingestion/sessions/{session_id}/finish", response_model=IngestionSessionView,
    )
    def finish_ingestion_session(
        session_id: str, request: FinishIngestionRequest,
    ) -> IngestionSessionView:
        return ingestion_service.finish_session(session_id, request)

    @application.get(
        "/ingestion/sessions/{session_id}", response_model=IngestionSessionView,
    )
    def ingestion_session(session_id: str) -> IngestionSessionView:
        return ingestion_service.get_session(session_id)

    @application.post(
        "/ingestion/sessions/{session_id}/index", response_model=IngestionSessionView,
    )
    def index_ingestion_session(session_id: str) -> IngestionSessionView:
        return ingestion_service.queue_session_indexing(session_id)

    @application.get("/indexing/jobs/{job_id}", response_model=IndexingJobView)
    def indexing_job(job_id: str) -> IndexingJobView:
        return ingestion_service.get_job(job_id)

    @application.post("/indexing/jobs/{job_id}/retry", response_model=IndexingJobView)
    def retry_indexing_job(job_id: str) -> IndexingJobView:
        return ingestion_service.retry_job(job_id)

    @application.post("/indexing/jobs/{job_id}/cancel", response_model=IndexingJobView)
    def cancel_indexing_job(job_id: str) -> IndexingJobView:
        return ingestion_service.cancel_job(job_id)

    @application.post("/indexing/jobs/pending", response_model=IndexingJobView)
    def queue_pending_indexing_job() -> IndexingJobView:
        return ingestion_service.queue_pending_messages()


async def _read_import_file(export_file: UploadFile) -> bytes:
    maximum_bytes = 100 * 1024 * 1024
    payload = await export_file.read(maximum_bytes + 1)
    if len(payload) > maximum_bytes:
        raise ValueError("WhatsApp export překračuje limit 100 MiB.")
    return payload


def _register_chat_routes(application: FastAPI, chat_service: DatabaseChatService) -> None:
    @application.get("/chat/scopes", response_model=ChatScopeList)
    def chat_scopes() -> ChatScopeList:
        return chat_service.list_scopes()

    @application.post("/chat", response_model=ChatResponse)
    def chat(request: ChatRequest) -> ChatResponse:
        return chat_service.answer(request)

    @application.get("/chat/sessions", response_model=list[ChatSessionSummary])
    def chat_sessions(
        limit: int = Query(default=10, ge=1, le=100),
    ) -> list[ChatSessionSummary]:
        return chat_service.list_sessions(limit)

    @application.get("/chat/sessions/{session_id}", response_model=ChatSessionDetail)
    def chat_session(session_id: str) -> ChatSessionDetail:
        return chat_service.get_session(session_id)

    @application.patch("/chat/sessions/{session_id}", response_model=ChatSessionSummary)
    def rename_chat_session(
        session_id: str, request: ChatSessionRename,
    ) -> ChatSessionSummary:
        return chat_service.rename_session(session_id, request.title)

    @application.delete("/chat/sessions/{session_id}")
    def delete_chat_session(session_id: str) -> dict:
        chat_service.delete_session(session_id)
        return {"deleted": True}


def _register_database_routes(
    application: FastAPI, overview_service: DatabaseOverviewService,
) -> None:
    @application.get("/database/overview", response_model=DatabaseOverview)
    def database_overview(
        limit: int = Query(default=50, ge=1, le=200),
        offset: int = Query(default=0, ge=0),
    ) -> DatabaseOverview:
        return overview_service.get_overview(limit, offset)

    @application.get("/database/resume-point", response_model=ChannelResumePoint)
    def database_resume_point(
        channel_id: str = Query(min_length=1, max_length=128),
        channel: Optional[str] = Query(default=None, max_length=300),
    ) -> ChannelResumePoint:
        return overview_service.get_resume_point(channel_id, channel)

    @application.delete("/database", response_model=ClearDatabaseResponse)
    def clear_database(_request: ClearDatabaseRequest) -> ClearDatabaseResponse:
        result = overview_service.clear_database()
        if isinstance(result, tuple):
            return ClearDatabaseResponse(
                deleted_chunks=result[0], deleted_messages=result[1],
            )
        return ClearDatabaseResponse(deleted_chunks=result)

def _resolve_services(
    ingestion_service: Optional[MessageIngestionService],
    chat_service: Optional[DatabaseChatService],
    overview_service: Optional[DatabaseOverviewService],
    settings_service: Optional[ApplicationSettingsService],
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
        settings.postgres_dsn, settings.embedding_model,
        settings.embedding_dimensions,
    )
    raw_repository.ensure_schema()
    provider_registry, index_repository, hybrid_repository, indexing_worker = (
        _build_model_stack(settings, raw_repository)
    )
    embedding_provider = OpenAIEmbeddingProvider(
        settings.openai_api_key, settings.embedding_model, settings.embedding_dimensions,
        settings.embedding_batch_size,
    )
    chat_provider = OpenAIChatCompletionProvider(
        settings.openai_api_key, settings.chat_model,
    )
    ingestion = MessageIngestionService(
        SourceMessageNormalizer(), raw_repository, indexing_worker,
    )
    chat = DatabaseChatService(
        repository, embedding_provider, chat_provider, hybrid_repository,
        PostgresChatScopeCatalog(settings.postgres_dsn),
        provider_registry=provider_registry, index_repository=index_repository,
        default_chat_model=settings.chat_model,
        chat_session_repository=PostgresChatSessionRepository(
            raw_repository.ensure_schema, raw_repository.open_connection,
        ),
    )
    overview = DatabaseOverviewService(repository, raw_repository)
    settings_service = ApplicationSettingsService(
        provider_registry, index_repository, hybrid_repository, raw_repository,
        indexing_worker, default_chat_model=settings.chat_model,
    )
    return ingestion, chat, overview, settings_service, settings.internal_token


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
