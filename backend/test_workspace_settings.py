import pytest

from backend.models import WorkspaceSettingsUpdate
from backend.workspace_settings import PostgresWorkspaceSettingsRepository


class FakeConnection:
    def __init__(self, row):
        self.row = row
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return False

    def execute(self, query, parameters=()):
        self.calls.append((" ".join(query.split()), parameters))
        return self

    def fetchone(self):
        return self.row


def test_workspace_settings_read_and_update_use_server_validation() -> None:
    schema_calls = []
    read_connection = FakeConnection(("UTC",))
    reader = PostgresWorkspaceSettingsRepository(
        lambda: schema_calls.append("read"), lambda: read_connection,
    )
    update_connection = FakeConnection(("Europe/Prague",))
    writer = PostgresWorkspaceSettingsRepository(
        lambda: schema_calls.append("write"), lambda: update_connection,
    )

    assert reader.get().timezone_name == "UTC"
    updated = writer.update(WorkspaceSettingsUpdate(timezone_name="Europe/Prague"))

    assert updated.timezone_name == "Europe/Prague"
    assert update_connection.calls[1][1] == ("Europe/Prague",)
    assert schema_calls == ["read", "write"]


def test_workspace_settings_reject_invalid_iana_zone_before_database_access() -> None:
    repository = PostgresWorkspaceSettingsRepository(
        lambda: (_ for _ in ()).throw(AssertionError("schema should not run")),
        lambda: (_ for _ in ()).throw(AssertionError("database should not run")),
    )

    with pytest.raises(ValueError, match="valid IANA"):
        repository.update(WorkspaceSettingsUpdate(timezone_name="Mars/Olympus"))
