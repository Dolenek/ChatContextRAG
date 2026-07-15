from datetime import datetime, timezone

from backend.embedding_index_support import index_view_sql
from backend.read_models.metadata import metadata_from_state
from backend.read_models.reader import PostgresReadModelReader
from backend.read_models.refresher import PostgresReadModelRefresher, RefreshClaim
from backend.read_models.schema import read_model_schema_statements
from backend.read_models.store import PostgresReadModelStore
from backend.raw_archive_reset import RawArchiveResetter


class QueryResult:
    def __init__(self, row=None, rows=None, rowcount=1) -> None:
        self.row = row
        self.rows = rows or []
        self.rowcount = rowcount

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class RecordingConnection:
    def __init__(self, responses=None) -> None:
        self.responses = list(responses or [])
        self.queries = []

    def execute(self, query, parameters=None):
        normalized = " ".join(query.split())
        self.queries.append((normalized, parameters))
        return self.responses.pop(0) if self.responses else QueryResult()

    def __enter__(self):
        return self

    def __exit__(self, _error_type, _error, _traceback):
        return False


def test_schema_contains_every_persistent_projection_and_durable_state() -> None:
    schema = " ".join(read_model_schema_statements())

    for table in (
        "workspace_read_summary", "embedding_index_read_summary",
        "chat_scope_read_model", "database_breakdown_read_model",
        "read_model_refresh_state",
    ):
        assert f"CREATE TABLE IF NOT EXISTS {table}" in schema
    assert "lease_expires_at" in schema
    assert "requested_revision" in schema
    assert "published_revision" in schema
    assert schema.count("REFERENCES embedding_indexes(id) ON DELETE CASCADE") == 4


def test_settings_index_query_contains_no_source_aggregate_scan() -> None:
    query = index_view_sql()

    assert "embedding_index_read_summary" in query
    assert "read_model_refresh_state" in query
    assert "COUNT(*) FROM rag_chunks" not in query
    assert "FROM source_messages" not in query
    assert "FROM rag_chunk_messages" not in query


def test_metadata_distinguishes_bootstrap_stale_running_and_failed() -> None:
    generated_at = datetime(2026, 7, 15, tzinfo=timezone.utc)

    ready = metadata_from_state((2, 2, "ready", generated_at, None), True)
    stale = metadata_from_state((3, 2, "queued", generated_at, None), True)
    failed = metadata_from_state((3, 2, "failed", generated_at, "private"), True)
    bootstrap = metadata_from_state((1, 0, "queued", None, None), False)

    assert ready.ready and not ready.stale and not ready.refreshing
    assert stale.ready and stale.stale and stale.refreshing
    assert failed.ready and failed.stale and not failed.refreshing
    assert failed.error and "private" not in failed.error
    assert not bootstrap.ready and bootstrap.refreshing


def test_import_invalidation_queues_archive_and_every_index_with_one_wake() -> None:
    connection = RecordingConnection()
    store = PostgresReadModelStore("unused")
    wake_calls = []
    store.set_wake_callback(lambda: wake_calls.append(True))

    store.invalidate_all(connection)

    combined = " ".join(query for query, _parameters in connection.queries)
    assert "SELECT 'index:'||id" in combined
    assert "requested_revision=requested_revision+1" in combined
    assert "WHERE TRUE" in combined
    assert connection.queries[-1][1] == (0,)
    assert wake_calls == [True]


def test_index_invalidation_is_scoped_and_can_bypass_debounce() -> None:
    connection = RecordingConnection()
    store = PostgresReadModelStore("unused")

    store.invalidate_index(connection, "index-1", immediate=True)

    assert connection.queries[-1][1] == (5, "index:index-1")
    assert "WHERE projection_key=%s" in connection.queries[-1][0]


def test_active_summary_reads_only_small_projection_tables() -> None:
    generated_at = datetime(2026, 7, 15, tzinfo=timezone.utc)
    responses = [
        QueryResult(("index-1",)),
        QueryResult((120, 100, 4, 3, None, generated_at)),
        QueryResult((30, 115, 5)),
        QueryResult(rows=[
            (2, 2, "ready", generated_at, None, True),
            (4, 4, "ready", generated_at, None, True),
        ]),
    ]
    connection = RecordingConnection(responses)

    summary, metadata = PostgresReadModelReader("unused").active_summary(connection)

    assert summary["raw_message_count"] == 120
    assert summary["duplicate_message_count"] == 20
    assert summary["pending_message_count"] == 5
    assert metadata.ready and not metadata.stale
    queries = " ".join(query for query, _parameters in connection.queries)
    assert "workspace_read_summary" in queries
    assert "embedding_index_read_summary" in queries
    assert "FROM source_messages" not in queries
    assert "FROM rag_chunks" not in queries
    assert "FROM rag_chunk_messages" not in queries


def test_breakdown_page_carries_projection_metadata() -> None:
    generated_at = datetime(2026, 7, 15, tzinfo=timezone.utc)
    connection = RecordingConnection([
        QueryResult(("index-1",)), QueryResult(rows=[("Ada", 20, 3), ("Bob", 10, 3)]),
        QueryResult((30, 115, 5, generated_at)),
        QueryResult((3, 2, "queued", generated_at, None)),
    ])

    page = PostgresReadModelReader("unused").breakdown_page(
        connection, "authors", 2, 0,
    )

    assert [item.label for item in page.items] == ["Ada", "Bob"]
    assert page.total == 3 and page.has_more and page.next_offset == 2
    assert page.summary_ready and page.summary_is_stale and page.summary_refreshing


def test_workspace_metadata_tracks_an_inactive_index_for_central_polling() -> None:
    generated_at = datetime(2026, 7, 15, tzinfo=timezone.utc)
    connection = RecordingConnection([QueryResult(rows=[
        (2, 2, "ready", generated_at, None, True),
        (5, 4, "queued", generated_at, None, True),
    ])])

    metadata = PostgresReadModelReader("unused").workspace_metadata(connection)

    assert metadata.ready and metadata.stale and metadata.refreshing


def test_refresh_claim_uses_debounce_lease_and_single_worker_lock() -> None:
    claim_sql = PostgresReadModelRefresher._claim_sql()

    assert "requested_at<=NOW()-(%s * INTERVAL '1 second')" in claim_sql
    assert "lease_expires_at<NOW()" in claim_sql
    assert "FOR UPDATE OF state SKIP LOCKED LIMIT 1" in claim_sql
    assert "pg_try_advisory_lock" in _method_source("_try_global_lock")


def test_completion_requeues_a_revision_created_during_refresh() -> None:
    connection = RecordingConnection([QueryResult(rowcount=1)])
    refresher = PostgresReadModelRefresher("unused")
    claim = RefreshClaim("index:index-1", "index", "index-1", 4, 0)

    refresher._complete(connection, claim)

    query, parameters = connection.queries[0]
    assert "requested_revision>%s THEN 'queued'" in query
    assert parameters[:2] == (4, 4)


def test_serialization_race_requeues_without_exposing_a_failure() -> None:
    connection = RecordingConnection()
    refresher = PostgresReadModelRefresher("unused")
    claim = RefreshClaim("archive", "archive", None, 4, 0)

    refresher._requeue_superseded(connection, claim)

    query, parameters = connection.queries[0]
    assert "status='queued'" in query
    assert "last_error=NULL" in query
    assert parameters == ("archive", refresher.worker_id)


def test_failure_keeps_snapshot_and_caps_retry_at_five_minutes() -> None:
    connection = RecordingConnection()
    refresher = PostgresReadModelRefresher("unused")
    claim = RefreshClaim("archive", "archive", None, 9, 20)

    refresher._record_failure(connection, claim, RuntimeError("private detail"))

    query, parameters = connection.queries[0]
    assert "DELETE" not in query
    assert parameters[0] == 300
    assert parameters[1] == "private detail"


def test_archive_clear_publishes_zero_snapshot_in_the_clear_transaction() -> None:
    connection = RecordingConnection([QueryResult((7,)), QueryResult((11,))])
    read_models = ResetStoreSpy()
    resetter = RawArchiveResetter(lambda: None, lambda: connection, read_models)

    deleted = resetter.delete_all()

    assert deleted == (7, 11)
    assert any("TRUNCATE rag_staged_chunk_messages" in query
               for query, _parameters in connection.queries)
    assert read_models.connections == [connection]


class ResetStoreSpy:
    def __init__(self) -> None:
        self.connections = []

    def reset(self, connection) -> None:
        self.connections.append(connection)


def _method_source(method_name: str) -> str:
    import inspect

    return inspect.getsource(getattr(PostgresReadModelRefresher, method_name))
