from datetime import datetime, timedelta, timezone

import pytest

from backend.chunking import ConversationAwareChunker
from backend.hybrid_repository import PostgresHybridRepository
from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.index_staging import PostgresIndexStaging
from backend.indexing_job_repository import PostgresIndexingJobRepository
from backend.indexing_job_sql import claim_job_sql, claimable_job_sql
from backend.indexing_worker import PersistentIndexingWorker
from backend.postgres_repository import PostgresVectorRepository
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import NormalizedMessage


def test_duplicate_collapse_respects_time_and_channel_boundaries() -> None:
    started_at = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
    messages = [
        _message("1", started_at, "channel-a"),
        _message("2", started_at + timedelta(minutes=21), "channel-a"),
        _message("3", started_at + timedelta(minutes=22), "channel-b"),
    ]

    collapsed = PersistentIndexingWorker._collapse_consecutive_duplicates(messages)

    assert [message.external_id for message in collapsed] == ["1", "2", "3"]


def test_collapsed_messages_preserve_the_full_timestamp_range() -> None:
    started_at = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
    messages = [
        _message("1", started_at, "channel-a"),
        _message("2", started_at + timedelta(minutes=5), "channel-a"),
    ]

    collapsed = PersistentIndexingWorker._collapse_consecutive_duplicates(messages)
    chunk = ConversationAwareChunker().chunk(collapsed)[0]

    assert chunk.source_message_ids == ["1", "2"]
    assert chunk.started_at == started_at
    assert chunk.ended_at == started_at + timedelta(minutes=5)


def test_chunk_boundary_uses_last_timestamp_from_collapsed_messages() -> None:
    started_at = datetime(2026, 7, 11, 10, 0, tzinfo=timezone.utc)
    messages = [
        _message("1", started_at, "channel-a"),
        _message("2", started_at + timedelta(minutes=19), "channel-a"),
        _message("3", started_at + timedelta(minutes=30), "channel-a", "reply"),
    ]

    collapsed = PersistentIndexingWorker._collapse_consecutive_duplicates(messages)
    chunks = ConversationAwareChunker().chunk(collapsed)

    assert len(chunks) == 1
    assert chunks[0].source_message_ids == ["1", "2", "3"]


def test_fulltext_context_keeps_the_anchor_after_a_large_time_gap() -> None:
    started_at = datetime(2026, 7, 11, 8, 0, tzinfo=timezone.utc)
    rows = [
        ("Old", "unrelated", started_at, "general", "1"),
        ("Ada", "matching", started_at + timedelta(hours=2), "general", "2"),
        ("Bob", "reply", started_at + timedelta(hours=2, minutes=5), "general", "3"),
    ]

    filtered = PostgresHybridRetrieval.apply_time_gap(rows, "2")

    assert [row[4] for row in filtered] == ["2", "3"]


def test_duplicate_external_ids_are_counted_once_with_last_value_winning() -> None:
    messages = [
        _message("1", None, "channel-a", "old"),
        _message("1", None, "channel-a", "edited"),
        _message("2", None, "channel-a", "second"),
    ]

    unique_messages = RawMessageWriter.deduplicate_messages(messages)

    assert len(unique_messages) == 2
    assert unique_messages[0].content == "edited"


def test_chunk_upserts_refresh_channel_and_timestamp_fields() -> None:
    legacy_sql = PostgresVectorRepository._upsert_sql()
    hybrid_sql = PostgresIndexStaging._commit_sql()

    for statement in (legacy_sql, hybrid_sql):
        assert "channel" in statement.split("DO UPDATE SET", 1)[1]
        assert "started_at" in statement.split("DO UPDATE SET", 1)[1]
        assert "ended_at" in statement.split("DO UPDATE SET", 1)[1]


def test_staging_locks_and_rechecks_the_running_job() -> None:
    connection = RecordingConnection((1,))

    PostgresIndexStaging._assert_owned_job(connection, "job-1", "worker-1")

    assert "FOR SHARE" in connection.statements[0][0]
    assert "worker_id=%s" in connection.statements[0][0]


def test_raw_message_writes_serialize_each_external_id() -> None:
    connection = RecordingConnection()
    messages = [_message("2", None, "channel-a"), _message("1", None, "channel-a")]

    RawMessageWriter._lock_message_ids(connection, messages)

    statement, parameters = connection.statements[0]
    assert "pg_advisory_xact_lock" in statement
    assert "ORDER BY message_id" in statement
    assert parameters == (["2", "1"],)


def _message(
    external_id: str, timestamp, channel_id: str, content: str = "same",
) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=external_id, author="Bot", content=content, timestamp=timestamp,
        channel=channel_id, channel_id=channel_id, guild_id="guild",
    )


class OneMessageRawRepository:
    def __init__(self, content: str) -> None:
        self.content = content
        self.status = "running"
        self.failed = None
        self.max_processed = 0

    def prepare_job_total(self, _job_id, _session_id, _worker_id):
        return 1

    def iter_indexing_messages(self, _job_id):
        yield _message("1", None, "channel-a", self.content)

    def renew_job_lease(self, _job_id, _worker_id):
        return self.status == "running"

    def update_job_progress(self, _job_id, _worker_id, processed, _stored_chunks):
        self.max_processed = max(self.max_processed, processed)
        return True

    def fail_job(self, _job_id, _worker_id, error):
        self.failed = error


class StagingRepository:
    def __init__(self) -> None:
        self.staged_chunks = 0
        self.committed = False

    def prepare_staging(self, _job_id, _worker_id):
        pass

    def stage_chunks(self, _job_id, _worker_id, chunks):
        count = len(list(chunks))
        self.staged_chunks += count
        return count

    def commit_staged_chunks(self, _job_id, _session_id, _worker_id):
        self.committed = True
        return True

class EmbeddingProvider:
    model_name = "fake"

    def __init__(self, raw_repository=None) -> None:
        self.raw_repository = raw_repository

    def embed_texts(self, texts):
        if self.raw_repository:
            self.raw_repository.status = "cancelled"
        return [[0.1, 0.2] for _text in texts]


def test_long_message_progress_never_exceeds_total_messages() -> None:
    raw_repository = OneMessageRawRepository("x" * 4_000)
    staging_repository = StagingRepository()
    worker = PersistentIndexingWorker(
        raw_repository, staging_repository, ConversationAwareChunker(),
        EmbeddingProvider(), embedding_batch_size=1,
    )

    worker._process_job("job", "session")

    assert raw_repository.failed is None
    assert raw_repository.max_processed == 1
    assert staging_repository.committed


def test_cancellation_during_embedding_discards_staging_without_replacing_index() -> None:
    raw_repository = OneMessageRawRepository("short")
    staging_repository = StagingRepository()
    worker = PersistentIndexingWorker(
        raw_repository, staging_repository, ConversationAwareChunker(),
        EmbeddingProvider(raw_repository), embedding_batch_size=1,
    )

    worker._process_job("job", "session")

    assert raw_repository.failed is None
    assert staging_repository.staged_chunks == 0
    assert not staging_repository.committed


class QueryResult:
    def __init__(self, row=None) -> None:
        self.row = row

    def fetchone(self):
        return self.row


class RecordingConnection:
    def __init__(self, default_row=None, update_row=None) -> None:
        self.statements = []
        self.default_row = default_row
        self.update_row = update_row

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False

    def execute(self, statement, parameters=None):
        self.statements.append((statement, parameters))
        if "to_regclass" in statement:
            return QueryResult(("rag_staged_chunks",))
        if statement.lstrip().startswith("UPDATE indexing_jobs") and "RETURNING id" in statement:
            return QueryResult(self.update_row)
        if "SELECT status FROM indexing_jobs" in statement:
            return QueryResult(("running",))
        return QueryResult(self.default_row)


def test_owned_failure_cleans_staging_and_releases_the_lease() -> None:
    connection = RecordingConnection(update_row=("job-1",))
    repository = PostgresIndexingJobRepository(lambda: None, lambda: connection)

    repository.fail("job-1", "worker-1", "embedding failed")

    update_sql = connection.statements[0][0]
    assert "status='running'" in update_sql
    assert "worker_id=%s" in update_sql
    assert "lease_expires_at=NULL" in update_sql
    assert any("DELETE FROM rag_staged_chunks" in item[0] for item in connection.statements)


def test_stale_worker_failure_cannot_clear_new_owner_staging() -> None:
    connection = RecordingConnection()
    repository = PostgresIndexingJobRepository(lambda: None, lambda: connection)

    repository.fail("job-1", "stale-worker", "late failure")

    assert not any("DELETE FROM rag_staged_chunks" in item[0] for item in connection.statements)


def test_cancellation_and_staging_cleanup_share_one_transaction() -> None:
    job_row = ("job-1", "session-1", "cancelled", 0, 0, 0, None, None, None, None)
    connection = RecordingConnection(default_row=job_row, update_row=("job-1",))
    repository = PostgresIndexingJobRepository(lambda: None, lambda: connection)

    repository.cancel("job-1")

    assert "status='cancelled'" in connection.statements[0][0]
    assert any("DELETE FROM rag_staged_chunks" in item[0] for item in connection.statements)


def test_retry_rejects_a_running_job_without_clearing_its_staging() -> None:
    connection = RecordingConnection()
    repository = PostgresIndexingJobRepository(lambda: None, lambda: connection)

    with pytest.raises(ValueError, match="completed, failed, or cancelled"):
        repository.retry("job-1")

    retry_sql = connection.statements[0][0]
    assert "finished_at<=transaction_timestamp()" in retry_sql
    assert not any("DELETE FROM rag_staged_chunks" in item[0] for item in connection.statements)


def test_session_write_locks_the_session_until_messages_are_linked() -> None:
    connection = RecordingConnection(("running",))

    RawMessageWriter._assert_running_session(connection, "session-1")

    assert "FOR UPDATE" in connection.statements[0][0]


def test_claiming_can_recover_only_expired_jobs_and_assigns_an_owner() -> None:
    selection_sql = claimable_job_sql()
    assignment_sql = claim_job_sql()

    assert "lease_expires_at<=NOW()" in selection_sql
    assert "FOR UPDATE SKIP LOCKED" in selection_sql
    assert "worker_id=%s" in assignment_sql
    assert "make_interval" in assignment_sql
