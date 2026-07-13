import io
import zipfile
from types import SimpleNamespace

import pytest

from backend.models import ImportResponse, IngestionSessionView, SourceMessageInput
from backend.whatsapp_import import WhatsAppImportCoordinator
from backend.whatsapp_parser import WhatsAppExportParser


def test_preview_reports_zip_entry_selection_without_starting_ingestion() -> None:
    payload = io.BytesIO()
    with zipfile.ZipFile(payload, "w") as archive:
        archive.writestr("one.txt", "13/7/2026 09:15 - Ada: One")
        archive.writestr("two.txt", "13/7/2026 09:15 - Ada: Two")
    ingestion = FakeIngestionService()

    preview = WhatsAppImportCoordinator(ingestion).preview(
        payload.getvalue(), "chat.zip", None, "UTC", None,
    )

    assert preview.requires_text_entry is True
    assert preview.available_text_entries == ["one.txt", "two.txt"]
    assert ingestion.sessions == []


def test_import_requires_explicit_order_for_ambiguous_dates() -> None:
    coordinator = WhatsAppImportCoordinator(FakeIngestionService())

    with pytest.raises(ValueError, match="DMY nebo MDY"):
        coordinator.import_export(
            b"7/8/26, 09:15 - Ada: Hello\n", "chat.txt", "family", "Family",
            None, "UTC", None,
        )


def test_import_stores_at_most_four_hundred_messages_per_request() -> None:
    ingestion = FakeIngestionService()
    parser = FakeParser(401)
    coordinator = WhatsAppImportCoordinator(ingestion, parser)

    result = coordinator.import_export(
        b"ignored", "chat.txt", "family", "Family", "DMY", "UTC", None,
    )

    assert [len(request.messages) for request in ingestion.import_requests] == [400, 1]
    assert result.parsed_count == 401
    assert result.imported_count == 401
    assert result.indexing_job_id == "job-1"
    assert ingestion.finish_reasons == ["completed"]


def test_failed_import_stops_the_created_session() -> None:
    ingestion = FakeIngestionService(fail_import=True)
    coordinator = WhatsAppImportCoordinator(ingestion, FakeParser(1))

    with pytest.raises(RuntimeError, match="storage failed"):
        coordinator.import_export(
            b"ignored", "chat.txt", "family", "Family", "DMY", "UTC", None,
        )

    assert ingestion.finish_reasons == ["stopped"]


@pytest.mark.parametrize(
    ("payload", "file_name", "message"),
    [
        (b"\xff", "chat.txt", "UTF-8"),
        (b"not a zip", "chat.zip", "platný ZIP"),
    ],
)
def test_parser_rejects_invalid_file_encodings_and_archives(payload, file_name, message) -> None:
    with pytest.raises(ValueError, match=message):
        WhatsAppExportParser().parse(payload, file_name)


def test_parser_rejects_unknown_timezone() -> None:
    with pytest.raises(ValueError, match="zóna"):
        WhatsAppExportParser().parse(
            b"13/7/2026 09:15 - Ada: Hello\n", "chat.txt",
            timezone_name="Mars/Olympus",
        )


class FakeIngestionService:
    def __init__(self, fail_import=False) -> None:
        self.fail_import = fail_import
        self.sessions = []
        self.import_requests = []
        self.finish_reasons = []

    def create_session(self, request):
        self.sessions.append(request)
        return IngestionSessionView(session_id="session-1", status="running")

    def ingest(self, request):
        if self.fail_import:
            raise RuntimeError("storage failed")
        self.import_requests.append(request)
        return ImportResponse(
            imported_count=len(request.messages), chunk_count=0,
            messages=request.messages,
        )

    def finish_session(self, _session_id, request):
        self.finish_reasons.append(request.reason)
        return IngestionSessionView(
            session_id="session-1", status=request.reason,
            indexing_job_id="job-1" if request.reason == "completed" else None,
        )


class FakeParser:
    def __init__(self, message_count) -> None:
        self.message_count = message_count

    def parse(self, *_arguments):
        return SimpleNamespace(
            messages=[object()] * self.message_count,
            requires_date_order=False,
        )

    def to_inputs(self, _parsed, conversation_id, conversation_label):
        return [SourceMessageInput(
            external_id=f"waexp:{index}", author="Ada", content=f"message {index}",
            source_type="whatsapp", conversation_id=conversation_id,
            conversation_label=conversation_label,
        ) for index in range(self.message_count)]
