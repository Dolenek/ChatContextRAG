import time

import pytest

from backend.job_lease import JobLeaseKeeper
from backend.raw_message_writer import RawMessageWriter
from backend.vector_models import NormalizedMessage


def test_raw_writer_runs_the_complete_deduplicated_storage_transaction() -> None:
    first = _message("1", "shared")
    edited = _message("1", "edited")
    second = _message("waexp:2", "new")
    connection = RecordingConnection(
        existing_ids={"1"}, existing_hashes={RawMessageWriter.content_hash("edited")},
        current_hashes={RawMessageWriter.content_hash("shared")},
    )

    stored_count, unique_content_count = RawMessageWriter().store_messages(
        connection, "session-1", [first, edited, second],
    )

    assert stored_count == 1
    assert unique_content_count == 1
    assert connection.executemany_calls[0][0].startswith("INSERT INTO message_contents")
    message_rows = connection.executemany_calls[1][1]
    assert [row[0] for row in message_rows] == ["1", "waexp:2"]
    assert message_rows[0][-1] == RawMessageWriter.content_hash("edited")
    assert any("UPDATE ingestion_sessions" in query for query, _ in connection.calls)


def test_raw_writer_rejects_missing_or_finished_sessions_before_writing() -> None:
    connection = RecordingConnection(session_status="completed")

    with pytest.raises(ValueError, match="not running"):
        RawMessageWriter().store_messages(connection, "session-1", [_message("1", "x")])

    assert connection.executemany_calls == []


def test_raw_identity_helpers_are_deterministic_for_numeric_and_namespaced_ids() -> None:
    assert RawMessageWriter.content_hash("hello") == RawMessageWriter.content_hash("hello")
    assert RawMessageWriter.message_order("123") == 123
    assert RawMessageWriter.message_order("waexp:digest") == 0


def test_job_lease_stops_renewing_after_ownership_is_lost() -> None:
    repository = LeaseRepository([False, True])
    keeper = JobLeaseKeeper(repository, "job-1", "worker-1")

    assert keeper.renew_now() is False
    assert keeper.renew_now() is False
    assert repository.calls == [("job-1", "worker-1")]


def test_job_lease_context_renews_in_the_background_and_stops_cleanly() -> None:
    repository = LeaseRepository([True, True, True])

    with JobLeaseKeeper(
        repository, "job-1", "worker-1", renewal_interval_seconds=0.005,
    ):
        deadline = time.monotonic() + 0.5
        while not repository.calls and time.monotonic() < deadline:
            time.sleep(0.001)

    calls_after_exit = len(repository.calls)
    time.sleep(0.01)
    assert calls_after_exit >= 1
    assert len(repository.calls) == calls_after_exit


def _message(external_id: str, content: str) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=external_id, author="Ada", content=content, timestamp=None,
        channel="general", channel_id="20", guild_id="10",
        conversation_id="20",
    )


class QueryResult:
    def __init__(self, rows=None, row=None) -> None:
        self.rows = rows or []
        self.row = row

    def fetchall(self):
        return self.rows

    def fetchone(self):
        return self.row


class RecordingCursor:
    def __init__(self, connection) -> None:
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False

    def executemany(self, statement, rows):
        self.connection.executemany_calls.append((statement.strip(), list(rows)))


class RecordingConnection:
    def __init__(
        self, session_status="running", existing_ids=None,
        existing_hashes=None, current_hashes=None,
    ) -> None:
        self.session_status = session_status
        self.existing_ids = existing_ids or set()
        self.existing_hashes = existing_hashes or set()
        self.current_hashes = current_hashes or set()
        self.calls = []
        self.executemany_calls = []

    def cursor(self):
        return RecordingCursor(self)

    def execute(self, query, parameters=None):
        self.calls.append((query, parameters))
        normalized = " ".join(query.split())
        if normalized.startswith("SELECT status FROM ingestion_sessions"):
            return QueryResult(row=(self.session_status,))
        if normalized.startswith("SELECT external_id FROM source_messages"):
            return QueryResult(rows=[(value,) for value in self.existing_ids])
        if normalized.startswith("SELECT content_hash FROM message_contents"):
            return QueryResult(rows=[(value,) for value in self.existing_hashes])
        if normalized.startswith("SELECT content_hash FROM source_messages"):
            return QueryResult(rows=[(value,) for value in self.current_hashes])
        return QueryResult()


class LeaseRepository:
    def __init__(self, outcomes) -> None:
        self.outcomes = list(outcomes)
        self.calls = []

    def renew_job_lease(self, job_id, worker_id):
        self.calls.append((job_id, worker_id))
        return self.outcomes.pop(0) if self.outcomes else True
