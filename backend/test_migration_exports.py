from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.migration_exports import (
    MigrationExportPage, MigrationExportService, MigrationExportView,
    register_migration_export_routes,
)
from backend.models import SourceMessageInput


class FakeMigrationExportService:
    def __init__(self) -> None:
        self.deleted = []

    def create_snapshot(self) -> MigrationExportView:
        return MigrationExportView(export_id="export-1", total_messages=2)

    def get_page(self, export_id, cursor, limit) -> MigrationExportPage:
        return MigrationExportPage(
            export_id=export_id, total_messages=2,
            messages=[SourceMessageInput(
                external_id="2", author="Ada", content="Hello",
            )],
            next_cursor="2", done=True,
        )

    def get_snapshot(self, export_id) -> MigrationExportView:
        return MigrationExportView(export_id=export_id, total_messages=2)

    def delete_snapshot(self, export_id) -> None:
        self.deleted.append(export_id)


def test_internal_migration_export_routes_require_token_and_page_snapshots() -> None:
    application = FastAPI()
    service = FakeMigrationExportService()
    register_migration_export_routes(application, service, "internal-secret")
    client = TestClient(application)

    unauthorized = client.post("/internal/migration-exports")
    created = client.post(
        "/internal/migration-exports", headers=_authorization(),
    )
    page = client.get(
        "/internal/migration-exports/export-1/messages?limit=100",
        headers=_authorization(),
    )
    snapshot = client.get(
        "/internal/migration-exports/export-1", headers=_authorization(),
    )
    deleted = client.delete(
        "/internal/migration-exports/export-1", headers=_authorization(),
    )

    assert unauthorized.status_code == 403
    assert created.json() == {"export_id": "export-1", "total_messages": 2}
    assert page.json()["messages"][0]["external_id"] == "2"
    assert page.json()["done"] is True
    assert snapshot.json() == {"export_id": "export-1", "total_messages": 2}
    assert deleted.json() == {"deleted": True}
    assert service.deleted == ["export-1"]


def test_migration_export_page_limit_is_bounded() -> None:
    application = FastAPI()
    register_migration_export_routes(application, FakeMigrationExportService(), "secret")
    response = TestClient(application).get(
        "/internal/migration-exports/export-1/messages?limit=401",
        headers={"X-Chat-Context-Token": "secret"},
    )

    assert response.status_code == 422


def test_export_page_logs_start_end_cursor_batch_length_and_duration(caplog) -> None:
    class DiagnosticService(MigrationExportService):
        def _load_page(self, export_id, cursor, limit):
            return MigrationExportPage(
                export_id=export_id, total_messages=2,
                messages=[SourceMessageInput(
                    external_id="2", author="Ada", content="Hello",
                )],
                next_cursor="2", done=True,
            )

    service = DiagnosticService(lambda: None, lambda: None)
    with caplog.at_level("INFO", logger="uvicorn.error"):
        page = service.get_page("export-1", "1", 100)

    assert page.next_cursor == "2"
    messages = [record.getMessage() for record in caplog.records]
    assert any("migration_export_page_start" in message for message in messages)
    assert any("migration_export_page_end" in message for message in messages)
    assert any("batch_length=1" in record.getMessage() for record in caplog.records)


def _authorization() -> dict:
    return {"X-Chat-Context-Token": "internal-secret"}
