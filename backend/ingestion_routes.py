from typing import Optional

from fastapi import FastAPI, File, Form, Query, UploadFile

from backend.models import (
    FinishIngestionRequest, HealthResponse, ImportRequest, ImportResponse,
    IndexingJobView, IngestionSessionRequest, IngestionSessionView,
    IntegrationSyncState, SourceConversationView, WhatsAppImportPreview,
    WhatsAppImportResponse,
)


def register_ingestion_routes(application, ingestion_service, whatsapp_importer) -> None:
    _register_message_routes(application, ingestion_service)
    _register_integration_routes(application, ingestion_service)
    _register_whatsapp_routes(application, whatsapp_importer)
    _register_session_routes(application, ingestion_service)
    _register_job_routes(application, ingestion_service)


def _register_message_routes(application: FastAPI, ingestion_service) -> None:
    @application.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        return HealthResponse(status="ok")

    @application.get("/internal/health", response_model=HealthResponse)
    def authenticated_health() -> HealthResponse:
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


def _register_integration_routes(application: FastAPI, ingestion_service) -> None:
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


def _register_whatsapp_routes(application: FastAPI, whatsapp_importer) -> None:
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

    @application.post("/imports/whatsapp", response_model=WhatsAppImportResponse)
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


def _register_session_routes(application: FastAPI, ingestion_service) -> None:
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


def _register_job_routes(application: FastAPI, ingestion_service) -> None:
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
        raise ValueError("WhatsApp export exceeds the 100 MiB limit.")
    return payload
