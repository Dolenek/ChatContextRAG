import os
import uuid
from datetime import datetime, timedelta, timezone

import psycopg
import pytest

from backend.models import ChatScope, IngestionSessionRequest
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import NormalizedMessage


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_message_context_reads_ten_neighbors_without_a_time_boundary() -> None:
    identity = uuid.uuid4().hex
    conversation_id = f"context-{identity}"
    other_conversation = f"other-{identity}"
    repository = PostgresRawMessageRepository(TEST_DSN)
    repository.ensure_schema()
    session = repository.create_session(IngestionSessionRequest(
        source_type="test", conversation_id=conversation_id,
    ))
    other_session = repository.create_session(IngestionSessionRequest(
        source_type="test", conversation_id=other_conversation,
    ))
    message_ids = [f"{identity}-{index:02d}" for index in range(25)]
    other_id = f"{identity}-other"
    messages = [
        context_message(message_id, conversation_id, index)
        for index, message_id in enumerate(message_ids)
    ]
    try:
        repository.store_messages(session.session_id, messages)
        repository.store_messages(other_session.session_id, [
            context_message(other_id, other_conversation, 12),
        ])
        context = repository.load_message_context(message_ids[12], 10, 10)
        wrong_scope = repository.load_message_context(
            message_ids[12], 10, 10,
            ChatScope(source_type="test", conversation_id=other_conversation),
        )
        assert [message.external_id for message in context] == message_ids[2:23]
        assert {message.conversation_id for message in context} == {conversation_id}
        assert wrong_scope == []
    finally:
        repository.delete_session(session.session_id)
        repository.delete_session(other_session.session_id)
        delete_context_messages(TEST_DSN, [*message_ids, other_id])


def context_message(message_id: str, conversation_id: str, order: int):
    return NormalizedMessage(
        external_id=message_id, author="Ada", content=f"content {message_id}",
        timestamp=datetime(2025, 1, 1, tzinfo=timezone.utc) + timedelta(days=order),
        channel=conversation_id, channel_id=None, guild_id=None,
        source_type="test", conversation_id=conversation_id, message_order=order,
    )


def delete_context_messages(database_dsn: str, message_ids) -> None:
    hashes = [RawMessageWriter.content_hash(f"content {item}") for item in message_ids]
    with psycopg.connect(database_dsn) as connection:
        connection.execute(
            "DELETE FROM source_messages WHERE external_id=ANY(%s)", (message_ids,),
        )
        connection.execute(
            "DELETE FROM message_contents WHERE content_hash=ANY(%s)", (hashes,),
        )
