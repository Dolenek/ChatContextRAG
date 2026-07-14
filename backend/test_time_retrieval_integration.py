import os
import uuid
from datetime import date, datetime, timezone

import psycopg
import pytest

from backend.archive_time import resolve_archive_time_range
from backend.hybrid_repository import PostgresHybridRepository
from backend.models import ChatScope, IngestionSessionRequest
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import NormalizedMessage


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_time_bounded_search_and_context_exclude_similar_messages_outside_range() -> None:
    identity = uuid.uuid4().hex
    conversation_id = f"time-search-{identity}"
    raw_repository = PostgresRawMessageRepository(TEST_DSN)
    hybrid_repository = PostgresHybridRepository(TEST_DSN, 1536)
    raw_repository.ensure_schema()
    hybrid_repository.ensure_schema()
    session = raw_repository.create_session(IngestionSessionRequest(
        source_type="test", conversation_id=conversation_id,
    ))
    timestamps = integration_timestamps()
    messages = build_messages(identity, conversation_id, timestamps)
    time_range = resolve_archive_time_range(
        date(2026, 6, 10), date(2026, 6, 17), "Europe/Prague",
    )
    scope = ChatScope(source_type="test", conversation_id=conversation_id)
    try:
        raw_repository.store_messages(session.session_id, messages)
        chunks = hybrid_repository.search_hybrid(
            "shared release marker", [0.0] * 1536, 8, scope,
            time_range=time_range,
        )
        result_ids = {
            message_id for chunk in chunks for message_id in chunk.source_message_ids
        }
        expected_ids = {messages[index].external_id for index in (2, 3, 4)}
        assert result_ids == expected_ids

        context = raw_repository.load_message_context(
            messages[3].external_id, 10, 10, scope, time_range,
        )
        assert {message.external_id for message in context} == expected_ids
    finally:
        raw_repository.delete_session(session.session_id)
        delete_messages(TEST_DSN, messages)


def build_messages(identity, conversation_id, timestamps):
    return [
        NormalizedMessage(
            external_id=f"{identity}-{index}", author="Ada",
            content=f"shared release marker {identity} occurrence {index}",
            timestamp=timestamp, channel=conversation_id, channel_id=None,
            guild_id=None, source_type="test", conversation_id=conversation_id,
            message_order=index,
        )
        for index, timestamp in enumerate(timestamps)
    ]


def integration_timestamps():
    return [
        datetime(2025, 6, 12, 10, tzinfo=timezone.utc),
        datetime(2026, 6, 9, 21, 59, tzinfo=timezone.utc),
        datetime(2026, 6, 10, 10, tzinfo=timezone.utc),
        datetime(2026, 6, 13, 10, tzinfo=timezone.utc),
        datetime(2026, 6, 17, 21, 59, tzinfo=timezone.utc),
        datetime(2026, 6, 17, 22, tzinfo=timezone.utc),
    ]


def delete_messages(database_dsn, messages) -> None:
    message_ids = [message.external_id for message in messages]
    hashes = [RawMessageWriter.content_hash(message.content) for message in messages]
    with psycopg.connect(database_dsn) as connection:
        connection.execute(
            "DELETE FROM source_messages WHERE external_id=ANY(%s)", (message_ids,),
        )
        connection.execute(
            "DELETE FROM message_contents WHERE content_hash=ANY(%s)", (hashes,),
        )
