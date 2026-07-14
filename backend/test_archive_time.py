from datetime import date, datetime, timezone

import pytest

from backend.archive_time import resolve_archive_time_range, validated_zone
from backend.archive_tool_contracts import SEARCH_TOOL, SearchArchiveArguments
from backend.raw_schema import raw_schema_statements


def test_prague_range_uses_inclusive_dates_and_exclusive_utc_end() -> None:
    time_range = resolve_archive_time_range(
        date(2026, 6, 10), date(2026, 6, 17), "Europe/Prague",
    )

    assert time_range.start_at == datetime(2026, 6, 9, 22, tzinfo=timezone.utc)
    assert time_range.end_at == datetime(2026, 6, 17, 22, tzinfo=timezone.utc)
    assert time_range.contains(datetime(2026, 6, 17, 21, 59, tzinfo=timezone.utc))
    assert not time_range.contains(datetime(2026, 6, 17, 22, tzinfo=timezone.utc))


def test_dst_day_is_not_treated_as_a_fixed_twenty_four_hours() -> None:
    time_range = resolve_archive_time_range(
        date(2026, 3, 29), date(2026, 3, 29), "Europe/Prague",
    )

    assert time_range.start_at == datetime(2026, 3, 28, 23, tzinfo=timezone.utc)
    assert time_range.end_at == datetime(2026, 3, 29, 22, tzinfo=timezone.utc)
    assert (time_range.end_at - time_range.start_at).total_seconds() == 23 * 3600


def test_open_ranges_and_invalid_zones_are_validated() -> None:
    open_start = resolve_archive_time_range(None, date(2026, 1, 1), "UTC")
    open_end = resolve_archive_time_range(date(2026, 1, 1), None, "UTC")

    assert open_start.start_at is None
    assert open_start.end_at == datetime(2026, 1, 2, tzinfo=timezone.utc)
    assert open_end.start_at == datetime(2026, 1, 1, tzinfo=timezone.utc)
    assert open_end.end_at is None
    with pytest.raises(ValueError, match="valid IANA"):
        validated_zone("Mars/Olympus")


def test_search_schema_requires_nullable_dates_and_server_validates_order() -> None:
    assert SEARCH_TOOL.parameters["required"] == ["query", "date_from", "date_to"]
    assert SEARCH_TOOL.parameters["properties"]["date_from"]["type"] == [
        "string", "null",
    ]
    with pytest.raises(ValueError, match="date_from"):
        SearchArchiveArguments(
            query="release", date_from=date(2026, 6, 18), date_to=date(2026, 6, 10),
        )


def test_schema_migrates_workspace_timezone_tool_audit_and_time_indexes() -> None:
    schema = "\n".join(raw_schema_statements())

    assert "timezone_name TEXT NOT NULL DEFAULT 'UTC'" in schema
    assert "ADD COLUMN IF NOT EXISTS tool_activity JSONB" in schema
    assert "DEFAULT '[]'" in schema
    assert "source_messages_scope_time" in schema
