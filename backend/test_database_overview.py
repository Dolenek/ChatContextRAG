from datetime import datetime, timezone

import pytest

from backend.postgres_overview_reader import (
    DatabaseDetailReader, DatabaseStatusReader, decode_chunk_cursor,
)


class QueryResult:
    def __init__(self, row=None, rows=None) -> None:
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class StatusConnection:
    def __init__(self) -> None:
        self.queries = []

    def execute(self, query, parameters=None):
        normalized = " ".join(query.split())
        self.queries.append((normalized, parameters))
        if "WITH raw_stats AS" in normalized:
            return QueryResult((120, 100, 4, 3, None, None, 30, 115))
        if "pg_size_pretty" in normalized:
            return QueryResult(("12 MB",))
        if "FROM indexing_jobs" in normalized:
            return QueryResult(rows=[])
        raise AssertionError(normalized)


class ChunkConnection:
    def __init__(self, rows) -> None:
        self.rows = rows
        self.query = ""
        self.parameters = None

    def execute(self, query, parameters=None):
        self.query = " ".join(query.split())
        self.parameters = parameters
        return QueryResult(rows=self.rows)


def test_status_uses_one_primary_aggregate_without_loading_details() -> None:
    connection = StatusConnection()

    status = DatabaseStatusReader().read(connection)

    assert status.total_chunks == 30
    assert status.total_source_messages == 120
    assert status.duplicate_message_count == 20
    assert status.pending_message_count == 5
    assert len(connection.queries) == 3
    combined_queries = " ".join(query for query, _parameters in connection.queries)
    assert "LATERAL UNNEST(authors)" not in combined_queries
    assert "ORDER BY updated_at" not in combined_queries
    assert "embedding_index_id=(SELECT active_embedding_index_id" in combined_queries


def test_chunk_page_uses_stable_keyset_cursor_and_active_index() -> None:
    updated_at = datetime(2026, 7, 14, 12, tzinfo=timezone.utc)
    rows = [_chunk_row(identifier, updated_at) for identifier in ("c", "b", "a")]
    connection = ChunkConnection(rows)

    page = DatabaseDetailReader().read_cursor_page(connection, 2, None)
    decoded_time, decoded_id = decode_chunk_cursor(page.next_cursor)

    assert [chunk.chunk_id for chunk in page.chunks] == ["c", "b"]
    assert page.has_more is True
    assert (decoded_time, decoded_id) == (updated_at, "b")
    assert "ORDER BY updated_at DESC,id DESC" in connection.query
    assert "embedding_index_id=(SELECT active_embedding_index_id" in connection.query
    assert connection.parameters[-1] == 3


def test_chunk_cursor_is_applied_as_timestamp_and_id_boundary() -> None:
    updated_at = datetime(2026, 7, 14, 12, tzinfo=timezone.utc)
    connection = ChunkConnection([])

    DatabaseDetailReader().read_cursor_page(connection, 50, (updated_at, "chunk-2"))

    assert connection.parameters[:3] == (updated_at, updated_at, "chunk-2")
    assert "(updated_at,id) < (%s,%s)" in connection.query


def test_breakdown_page_limits_payload_and_reports_next_offset() -> None:
    connection = ChunkConnection([
        ("Ada", 20, 3), ("Bob", 10, 3),
    ])

    page = DatabaseDetailReader().read_breakdown_page(
        connection, "authors", 2, 0,
    )

    assert [item.label for item in page.items] == ["Ada", "Bob"]
    assert page.total == 3
    assert page.has_more is True
    assert page.next_offset == 2
    assert connection.parameters == (2, 0)
    assert "WITH counts AS MATERIALIZED" in connection.query


def test_breakdown_page_rejects_unknown_dimension() -> None:
    with pytest.raises(ValueError, match="Unsupported database breakdown"):
        DatabaseDetailReader().read_breakdown_page(
            ChunkConnection([]), "unknown", 50, 0,
        )


@pytest.mark.parametrize("cursor", ["not-base64", "e30", "WyJub3QiLCJhbiIsIm9iamVjdCJd"])
def test_invalid_chunk_cursor_is_rejected(cursor) -> None:
    with pytest.raises(ValueError, match="Invalid database chunk cursor"):
        decode_chunk_cursor(cursor)


def _chunk_row(identifier, updated_at):
    return (
        identifier, f"content {identifier}", ["Ada"], [f"message-{identifier}"],
        "general", updated_at, updated_at, "embedding-model", {}, updated_at,
    )
