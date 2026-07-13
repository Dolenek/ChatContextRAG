from backend.models import IntegrationSyncState
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository


def test_session_count_uses_inserted_link_delta() -> None:
    connection = RecordingConnection()

    RawMessageWriter._increment_session_count(connection, "session-1", 73)

    statement, parameters = connection.calls[0]
    assert "raw_message_count=raw_message_count+%s" in statement
    assert "COUNT(" not in statement
    assert parameters == (73, "session-1")


def test_sync_state_upsert_does_not_recalculate_conversation_counts(monkeypatch) -> None:
    repository = PostgresRawMessageRepository("postgresql://unused")
    repository._initialized = True
    connection = RecordingConnection(saved_state_row=(
        "discord", "channel-1", "guild-1", "General", "Guild", "10", "20",
        "session-1", False, True, None,
    ))
    monkeypatch.setattr(repository, "_connect", lambda: connection)
    monkeypatch.setattr(
        repository, "list_sync_states",
        lambda _source_type: (_ for _ in ()).throw(AssertionError("expensive list called")),
    )
    state = IntegrationSyncState(
        source_type="discord", conversation_id="channel-1",
        raw_message_count=1200, indexed_message_count=1000,
    )

    saved = repository.upsert_sync_state(state)

    assert saved.raw_message_count == 1200
    assert saved.indexed_message_count == 1000
    assert len(connection.calls) == 1


def test_sync_state_list_aggregates_each_message_table_once(monkeypatch) -> None:
    repository = PostgresRawMessageRepository("postgresql://unused")
    repository._initialized = True
    connection = RecordingConnection(rows=[])
    monkeypatch.setattr(repository, "_connect", lambda: connection)

    assert repository.list_sync_states("discord") == []

    statement, parameters = connection.calls[0]
    assert "WITH raw_counts AS" in statement
    assert "indexed_counts AS" in statement
    assert "LEFT JOIN raw_counts" in statement
    assert parameters == ("discord", "discord", "discord")


class QueryResult:
    def __init__(self, row=None, rows=None) -> None:
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class RecordingConnection:
    def __init__(self, saved_state_row=None, rows=None) -> None:
        self.saved_state_row = saved_state_row
        self.rows = rows or []
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False

    def execute(self, statement, parameters=None):
        normalized = " ".join(statement.split())
        self.calls.append((normalized, parameters))
        return QueryResult(self.saved_state_row, self.rows)
