from datetime import datetime, timezone

import pytest

from backend.postgres_overview_reader import (
    DatabaseDetailReader, DatabaseLiveReader, decode_chunk_cursor,
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


def test_live_status_reads_only_database_size_and_recent_jobs() -> None:
    connection = StatusConnection()

    status = DatabaseLiveReader().read(connection)

    assert status["database_size"] == "12 MB"
    assert status["indexing_jobs"] == []
    assert len(connection.queries) == 2
    combined_queries = " ".join(query for query, _parameters in connection.queries)
    assert "source_messages" not in combined_queries
    assert "rag_chunks" not in combined_queries


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


@pytest.mark.parametrize("cursor", ["not-base64", "e30", "WyJub3QiLCJhbiIsIm9iamVjdCJd"])
def test_invalid_chunk_cursor_is_rejected(cursor) -> None:
    with pytest.raises(ValueError, match="Invalid database chunk cursor"):
        decode_chunk_cursor(cursor)


def _chunk_row(identifier, updated_at):
    return (
        identifier, f"content {identifier}", ["Ada"], [f"message-{identifier}"],
        "general", updated_at, updated_at, "embedding-model", {}, updated_at,
    )
