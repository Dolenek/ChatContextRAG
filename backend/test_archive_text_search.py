import os
import uuid
from datetime import date, datetime, timedelta, timezone

import psycopg
import pytest
from pydantic import ValidationError
from psycopg import sql

from backend.archive_text_search import PostgresArchiveTextSearch
from backend.archive_time import resolve_archive_time_range
from backend.archive_tool_contracts import SearchTextArguments
from backend.chat_models import ChatScope
from backend.raw_message_writer import RawMessageWriter
from backend.vector_models import NormalizedMessage


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


def test_text_search_arguments_normalize_patterns_and_enforce_bounds() -> None:
    arguments = SearchTextArguments(
        patterns=[" deadlock ", "deadlock"], match_mode="term_prefix",
        operator="all", sort="oldest", limit=3,
    )

    assert arguments.patterns == ["deadlock"]
    with pytest.raises(ValidationError):
        SearchTextArguments(
            patterns=["x"] * 9, match_mode="whole_term",
            operator="any", sort="newest", limit=1,
        )
    with pytest.raises(ValidationError):
        SearchTextArguments(
            patterns=["x"], match_mode="whole_term",
            operator="any", sort="newest", limit=21,
        )


def test_text_search_sql_uses_indexed_modes_and_server_filters() -> None:
    search = PostgresArchiveTextSearch(lambda: None, lambda: None)
    prefix = search._content_condition(2, "term_prefix", "all")
    phrase = search._content_condition(2, "token_phrase", "any")
    whole = search._content_condition(1, "whole_term", "all")
    fragment, parameters = search._from_where(
        ["deadlock"], "term_prefix", "all",
        ChatScope(source_type="whatsapp", conversation_id="family"),
        None, ["trigger"], datetime(2026, 7, 15, tzinfo=timezone.utc),
    )

    assert prefix.count(":*") == 2 and " AND " in prefix
    assert phrase.count("phraseto_tsquery") == 2 and " OR " in phrase
    assert "plainto_tsquery" in whole
    assert "m.source_type=%s" in fragment
    assert "m.external_id<>ALL" in fragment
    assert parameters[1:5] == ("whatsapp", "whatsapp", "family", "family")
    assert "m.message_order ASC" in search._search_query(fragment, object(), "oldest")
    assert "m.sent_at DESC NULLS LAST" in search._search_query(fragment, None, "newest")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_postgres_text_search_modes_scope_order_and_raw_independence() -> None:
    identity = uuid.uuid4().hex
    schema_name = f"archive_text_{identity}"
    connection_factory = _isolated_connection_factory(schema_name)
    started = datetime(2026, 7, 10, 8, tzinfo=timezone.utc)
    discord_messages = _discord_messages(identity, started)
    whatsapp_message = _message(
        f"wa-{identity}", f"{identity} deadlock", started - timedelta(days=1),
        "whatsapp", f"family-{identity}", 1,
    )
    messages = [*discord_messages, whatsapp_message]
    try:
        _create_isolated_raw_schema(schema_name)
        _store_messages(connection_factory, messages)
        search = PostgresArchiveTextSearch(lambda: None, connection_factory)
        _assert_scoped_modes(search, identity, discord_messages)
        _assert_global_chronology(search, identity, whatsapp_message, messages)
        _assert_server_filters(search, identity, discord_messages)
    finally:
        _drop_isolated_raw_schema(schema_name)


def _assert_scoped_modes(search, identity, messages) -> None:
    scope = ChatScope(source_type="discord", conversation_id=f"room-{identity}")
    prefix = search.search(
        patterns=["deadlock", identity], match_mode="term_prefix",
        operator="all", sort="oldest", limit=20, scope=scope,
    )
    whole = search.search(
        patterns=["deadlock", identity], match_mode="whole_term",
        operator="all", sort="oldest", limit=20, scope=scope,
    )
    phrase = search.search(
        patterns=[f"production deadlock {identity}"], match_mode="token_phrase",
        operator="all", sort="oldest", limit=20, scope=scope,
    )

    assert [item.external_id for item in prefix.messages] == [
        messages[0].external_id, messages[1].external_id, messages[2].external_id,
    ]
    assert [item.external_id for item in whole.messages] == [messages[1].external_id]
    assert [item.external_id for item in phrase.messages] == [messages[1].external_id]
    assert prefix.ordering_basis == "source_order"
    assert prefix.chronology_complete is True


def _assert_global_chronology(search, identity, whatsapp_message, messages) -> None:
    global_result = search.search(
        patterns=["deadlock", identity], match_mode="term_prefix",
        operator="all", sort="oldest", limit=20,
    )
    assert global_result.messages[0].external_id == whatsapp_message.external_id
    assert global_result.ordering_basis == "timestamp"
    assert global_result.chronology_complete is False
    assert global_result.messages[-1].external_id == messages[2].external_id


def _assert_server_filters(search, identity, messages) -> None:
    scope = ChatScope(source_type="discord", conversation_id=f"room-{identity}")
    time_range = resolve_archive_time_range(date(2026, 7, 10), date(2026, 7, 10), "UTC")
    result = search.search(
        patterns=["deadlock", identity], match_mode="term_prefix",
        operator="all", sort="newest", limit=20, scope=scope,
        time_range=time_range, excluded_message_ids=[messages[1].external_id],
        maximum_timestamp=messages[1].timestamp + timedelta(minutes=30),
    )
    assert [item.external_id for item in result.messages] == [messages[0].external_id]


def _discord_messages(identity, started):
    conversation = f"room-{identity}"
    return [
        _message(
            f"d1-{identity}", f"{identity} DEADLOCKU observed", started,
            "discord", conversation, 1,
        ),
        _message(
            f"d2-{identity}", f"production deadlock {identity}",
            started + timedelta(hours=1), "discord", conversation, 2,
        ),
        _message(
            f"d3-{identity}", f"{identity} deadlocky later", None,
            "discord", conversation, 3,
        ),
    ]


def _message(external_id, content, timestamp, source_type, conversation_id, order):
    return NormalizedMessage(
        external_id=external_id, author="Ada", content=content,
        timestamp=timestamp, channel=conversation_id, channel_id=None, guild_id=None,
        source_type=source_type, conversation_id=conversation_id, message_order=order,
    )


def _isolated_connection_factory(schema_name):
    def connect():
        connection = psycopg.connect(TEST_DSN)
        connection.execute(sql.SQL("SET search_path TO {}").format(
            sql.Identifier(schema_name),
        ))
        return connection
    return connect


def _create_isolated_raw_schema(schema_name) -> None:
    with psycopg.connect(TEST_DSN) as connection:
        identifier = sql.Identifier(schema_name)
        connection.execute(sql.SQL("CREATE SCHEMA {}").format(identifier))
        connection.execute(sql.SQL("""CREATE TABLE {}.message_contents (
            content_hash TEXT PRIMARY KEY, content TEXT NOT NULL,
            search_vector TSVECTOR GENERATED ALWAYS AS
              (to_tsvector('simple',content)) STORED)""").format(identifier))
        connection.execute(sql.SQL("""CREATE TABLE {}.source_messages (
            external_id TEXT PRIMARY KEY, message_order BIGINT NOT NULL,
            author TEXT NOT NULL, sent_at TIMESTAMPTZ, channel TEXT,
            channel_id TEXT, guild_id TEXT, source_type TEXT NOT NULL,
            conversation_id TEXT, conversation_label TEXT, container_id TEXT,
            container_label TEXT, source_metadata JSONB NOT NULL DEFAULT '{{}}',
            content_hash TEXT NOT NULL)""").format(identifier))


def _store_messages(connection_factory, messages) -> None:
    with connection_factory() as connection:
        for message in messages:
            content_hash = RawMessageWriter.content_hash(message.content)
            connection.execute(
                "INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)",
                (content_hash, message.content),
            )
            connection.execute("""INSERT INTO source_messages
                (external_id,message_order,author,sent_at,channel,channel_id,guild_id,
                 source_type,conversation_id,conversation_label,content_hash)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", (
                    message.external_id, message.message_order, message.author,
                    message.timestamp, message.channel, message.channel_id,
                    message.guild_id, message.source_type, message.conversation_id,
                    message.conversation_label, content_hash,
                ))


def _drop_isolated_raw_schema(schema_name) -> None:
    with psycopg.connect(TEST_DSN) as connection:
        connection.execute(sql.SQL("DROP SCHEMA IF EXISTS {} CASCADE").format(
            sql.Identifier(schema_name),
        ))
