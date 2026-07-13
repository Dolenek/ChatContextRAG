from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.migration_exports import (
    MigrationExportPage, MigrationExportView, register_migration_export_routes,
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
    deleted = client.delete(
        "/internal/migration-exports/export-1", headers=_authorization(),
    )

    assert unauthorized.status_code == 403
    assert created.json() == {"export_id": "export-1", "total_messages": 2}
    assert page.json()["messages"][0]["external_id"] == "2"
    assert page.json()["done"] is True
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


def _authorization() -> dict:
    return {"X-Chat-Context-Token": "internal-secret"}
