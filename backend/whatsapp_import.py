from typing import Optional

from backend.models import (
    FinishIngestionRequest, ImportRequest, IngestionSessionRequest,
    WhatsAppImportPreview, WhatsAppImportResponse,
)
from backend.services import MessageIngestionService
from backend.whatsapp_parser import (
    WhatsAppExportParser, WhatsAppTextEntrySelectionRequired,
)


class WhatsAppImportCoordinator:
    def __init__(
        self, ingestion_service: MessageIngestionService,
        parser: Optional[WhatsAppExportParser] = None,
    ) -> None:
        self.ingestion_service = ingestion_service
        self.parser = parser or WhatsAppExportParser()

    def preview(
        self, payload: bytes, file_name: str, date_order: Optional[str],
        timezone_name: str, text_entry: Optional[str],
    ) -> WhatsAppImportPreview:
        try:
            parsed = self.parser.parse(
                payload, file_name, date_order, timezone_name, text_entry,
            )
        except WhatsAppTextEntrySelectionRequired as error:
            return WhatsAppImportPreview(
                file_name=file_name, message_count=0,
                available_text_entries=error.entries, requires_text_entry=True,
            )
        return WhatsAppImportPreview(
            file_name=file_name, text_entry=parsed.text_entry,
            detected_date_order=parsed.detected_date_order,
            requires_date_order=parsed.requires_date_order,
            message_count=len(parsed.messages),
            media_placeholder_count=sum(item.is_media_placeholder for item in parsed.messages),
            system_message_count=sum(item.is_system for item in parsed.messages),
            samples=parsed.preview_samples(),
        )

    def import_export(
        self, payload: bytes, file_name: str, conversation_id: str,
        conversation_label: str, date_order: Optional[str], timezone_name: str,
        text_entry: Optional[str],
    ) -> WhatsAppImportResponse:
        parsed = self.parser.parse(
            payload, file_name, date_order, timezone_name, text_entry,
        )
        if parsed.requires_date_order and not date_order:
            raise ValueError("U nejednoznačného data zvolte DMY nebo MDY.")
        messages = self.parser.to_inputs(parsed, conversation_id, conversation_label)
        session = self.ingestion_service.create_session(IngestionSessionRequest(
            source_type="whatsapp", conversation_id=conversation_id,
            conversation_label=conversation_label,
        ))
        try:
            imported_count = self._store_batches(session.session_id, messages)
            finished = self.ingestion_service.finish_session(
                session.session_id, FinishIngestionRequest(reason="completed"),
            )
        except Exception:
            try:
                self.ingestion_service.finish_session(
                    session.session_id, FinishIngestionRequest(reason="stopped"),
                )
            except Exception:
                pass
            raise
        return WhatsAppImportResponse(
            parsed_count=len(messages), imported_count=imported_count,
            duplicate_count=len(messages) - imported_count, skipped_count=0,
            conversation_id=conversation_id,
            indexing_job_id=finished.indexing_job_id,
        )

    def _store_batches(self, session_id: str, messages: list) -> int:
        imported_count = 0
        for start in range(0, len(messages), 400):
            response = self.ingestion_service.ingest(ImportRequest(
                session_id=session_id, messages=messages[start:start + 400],
            ))
            imported_count += response.imported_count
        return imported_count
