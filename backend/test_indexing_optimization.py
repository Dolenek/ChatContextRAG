from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.index_staging import PostgresIndexStaging
from backend.hybrid_repository import PostgresHybridRepository
from backend.raw_schema import raw_schema_statements


def test_incremental_commit_deletes_only_chunks_in_the_job_snapshot() -> None:
    connection = RecordingConnection()

    PostgresIndexStaging._replace_session_chunks(
        connection, "job-1", "session-1", "index-1", "incremental",
    )

    deletion, parameters = connection.calls[0]
    assert "JOIN indexing_job_messages" in deletion
    assert "jm.job_id=%s" in deletion
    assert "ingestion_session_messages" not in deletion
    assert parameters == ("index-1", "index-1", "job-1")


def test_ready_index_completion_does_not_chain_a_maintenance_job(monkeypatch) -> None:
    repository = _repository(monkeypatch, ("ready", True))
    queued_indexes = []
    monkeypatch.setattr(
        repository, "_queue_missing_messages",
        lambda _connection, index_id: queued_indexes.append(index_id),
    )

    repository.mark_ready("index-1")

    assert queued_indexes == []


def test_initial_build_completion_queues_one_catchup_job(monkeypatch) -> None:
    repository = _repository(monkeypatch, ("building", True))
    queued_indexes = []
    monkeypatch.setattr(
        repository, "_queue_missing_messages",
        lambda _connection, index_id: queued_indexes.append(index_id),
    )

    repository.mark_ready("index-1")

    assert queued_indexes == ["index-1"]


def test_schema_prevents_parallel_maintenance_sync_jobs() -> None:
    schema = "\n".join(raw_schema_statements())

    assert "indexing_jobs_active_sync_unique" in schema
    assert "job_type='sync' AND status IN ('queued','running')" in schema
    assert "indexing_job_messages(message_id,job_id)" in schema


def test_schema_supports_ordered_job_streams_and_index_message_lookups() -> None:
    schema = "\n".join(raw_schema_statements())
    metadata_indexes = PostgresHybridRepository._create_metadata_indexes_sql()

    assert "source_messages_global_order" in schema
    assert "source_messages(message_order,external_id)" in schema
    assert "rag_chunk_messages(embedding_index_id,message_id)" in metadata_indexes


def test_staging_replaces_links_for_a_whole_batch() -> None:
    cursor = RecordingCursor()
    chunks = [
        EmbeddedItem("chunk-1", ["message-1", "message-2"]),
        EmbeddedItem("chunk-2", ["message-3"]),
    ]

    PostgresIndexStaging._replace_batch_links(
        cursor, "job-1", "index-1", chunks,
    )

    assert cursor.calls[0][1] == ("job-1", ["chunk-1", "chunk-2"])
    assert len(cursor.executemany_calls[0][1]) == 3


def _repository(monkeypatch, index_state):
    repository = PostgresEmbeddingIndexRepository(
        "postgresql://unused", object(), "test-model", 2,
    )
    connection = RecordingConnection(index_state)
    monkeypatch.setattr(repository, "_connect", lambda: connection)
    return repository


class QueryResult:
    def __init__(self, row=None) -> None:
        self.row = row

    def fetchone(self):
        return self.row


class RecordingConnection:
    def __init__(self, index_state=None) -> None:
        self.index_state = index_state
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False

    def execute(self, statement, parameters=None):
        self.calls.append((" ".join(statement.split()), parameters))
        if statement.lstrip().startswith("SELECT status,auto_sync"):
            return QueryResult(self.index_state)
        return QueryResult()


class RecordingCursor:
    def __init__(self) -> None:
        self.calls = []
        self.executemany_calls = []

    def execute(self, statement, parameters=None):
        self.calls.append((" ".join(statement.split()), parameters))

    def executemany(self, statement, parameters):
        self.executemany_calls.append((" ".join(statement.split()), list(parameters)))


class Chunk:
    def __init__(self, chunk_id, source_message_ids) -> None:
        self.chunk_id = chunk_id
        self.source_message_ids = source_message_ids


class EmbeddedItem:
    def __init__(self, chunk_id, source_message_ids) -> None:
        self.chunk = Chunk(chunk_id, source_message_ids)
