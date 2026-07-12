import pytest

from backend.pending_indexing import PostgresPendingIndexingJobCreator


class QueryResult:
    def __init__(self, row=None, rowcount=-1) -> None:
        self.row = row
        self.rowcount = rowcount

    def fetchone(self):
        return self.row


class RecordingConnection:
    def __init__(self, pending_count: int) -> None:
        self.pending_count = pending_count
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False

    def execute(self, statement, parameters=None):
        self.statements.append((statement, parameters))
        if statement.lstrip().startswith("SELECT active_embedding_index_id"):
            return QueryResult(("default-openai",))
        if statement.lstrip().startswith("INSERT INTO ingestion_session_messages"):
            return QueryResult(rowcount=self.pending_count)
        if statement.lstrip().startswith("UPDATE ingestion_sessions"):
            return QueryResult((self.pending_count,))
        return QueryResult()


def test_pending_job_snapshots_only_unindexed_messages_without_an_active_job() -> None:
    connection = RecordingConnection(pending_count=42)
    creator = PostgresPendingIndexingJobCreator(lambda: None, lambda: connection)

    job_id = creator.queue()

    pending_sql = next(
        statement for statement, _parameters in connection.statements
        if statement.lstrip().startswith("INSERT INTO ingestion_session_messages")
    )
    queue_parameters = connection.statements[-1][1]
    assert "LEFT JOIN rag_chunk_messages" in pending_sql
    assert "active_job.status IN ('queued','running')" in pending_sql
    assert "pg_advisory_xact_lock" in connection.statements[0][0]
    assert queue_parameters[0] == job_id
    assert queue_parameters[2] == "default-openai"
    assert queue_parameters[3] == 42


def test_pending_job_is_not_created_when_nothing_is_uncovered() -> None:
    connection = RecordingConnection(pending_count=0)
    creator = PostgresPendingIndexingJobCreator(lambda: None, lambda: connection)

    with pytest.raises(ValueError, match="Žádné nezaindexované zprávy"):
        creator.queue()

    assert not any(
        statement.lstrip().startswith("INSERT INTO indexing_jobs")
        for statement, _parameters in connection.statements
    )
