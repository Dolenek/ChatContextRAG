import os
import uuid
from contextlib import contextmanager

import psycopg
import pytest
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from backend.hybrid_repository import PostgresHybridRepository
from backend.models import IngestionSessionRequest
from backend.raw_repository import PostgresRawMessageRepository
from backend.read_models import (
    PostgresReadModelReader, PostgresReadModelRefresher, PostgresReadModelStore,
)
from backend.vector_models import NormalizedMessage


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_backfill_invalidation_failure_and_atomic_empty_reset() -> None:
    with isolated_database_dsn() as database_dsn:
        store = PostgresReadModelStore(database_dsn)
        repository = PostgresRawMessageRepository(
            database_dsn, read_model_store=store,
        )
        repository.ensure_schema()
        PostgresHybridRepository(
            database_dsn, 1536, store,
        ).ensure_schema()
        session = repository.create_session(IngestionSessionRequest(
            source_type="test", conversation_id="read-model",
        ))
        repository.store_messages(session.session_id, [message("one"), message("two")])
        run_every_refresh(database_dsn)

        summary, metadata = read_active_summary(database_dsn)
        assert summary["raw_message_count"] == 2
        assert summary["pending_message_count"] == 2
        assert metadata.ready and not metadata.stale
        assert_breakdowns_count_raw_messages(database_dsn)

        repository.store_messages(session.session_id, [message("one", "edited")])
        _summary, stale_metadata = read_active_summary(database_dsn)
        assert stale_metadata.ready and stale_metadata.stale

        run_every_refresh(database_dsn)
        assert_failed_refresh_preserves_scope(database_dsn, store)

        repository.delete_all()
        cleared, cleared_metadata = read_active_summary(database_dsn)
        assert cleared["raw_message_count"] == 0
        assert cleared["total_chunks"] == 0
        assert cleared_metadata.ready and not cleared_metadata.stale


def assert_failed_refresh_preserves_scope(database_dsn, store) -> None:
    with psycopg.connect(database_dsn) as connection:
        index_id = PostgresReadModelReader.active_index_id(connection)
        connection.execute("""INSERT INTO chat_scope_read_model
            (embedding_index_id,source_type,conversation_id,display_name,message_count)
            VALUES (%s,'test','preserved','Preserved',2)""", (index_id,))
        store.invalidate_index(connection, index_id, immediate=True)
    refresher = PostgresReadModelRefresher(database_dsn, debounce_seconds=0)
    refresher._replace_breakdowns = fail_breakdown_refresh

    assert refresher.refresh_next()

    with psycopg.connect(database_dsn) as connection:
        scope_exists = connection.execute("""SELECT 1 FROM chat_scope_read_model
            WHERE embedding_index_id=%s AND conversation_id='preserved'""",
            (index_id,),
        ).fetchone()
        state = connection.execute("""SELECT status FROM read_model_refresh_state
            WHERE projection_key=%s""", (f"index:{index_id}",)).fetchone()
    assert scope_exists == (1,)
    assert state == ("failed",)


def fail_breakdown_refresh(_connection, _index_id) -> None:
    raise RuntimeError("simulated projection failure")


def run_every_refresh(database_dsn) -> None:
    refresher = PostgresReadModelRefresher(database_dsn, debounce_seconds=0)
    for _attempt in range(10):
        if not refresher.refresh_next():
            return
    raise AssertionError("Read-model refresh queue did not drain.")


def read_active_summary(database_dsn):
    with psycopg.connect(database_dsn) as connection:
        return PostgresReadModelReader(database_dsn).active_summary(connection)


def assert_breakdowns_count_raw_messages(database_dsn) -> None:
    with psycopg.connect(database_dsn) as connection:
        reader = PostgresReadModelReader(database_dsn)
        authors = reader.breakdown_page(connection, "authors", 50, 0)
        channels = reader.breakdown_page(connection, "channels", 50, 0)
    assert [(item.label, item.count) for item in authors.items] == [("Ada", 2)]
    assert [(item.label, item.count) for item in channels.items] == [("Read model", 2)]


def message(identifier: str, content: str = "original") -> NormalizedMessage:
    return NormalizedMessage(
        external_id=identifier, author="Ada", content=f"{content}-{identifier}",
        timestamp=None, channel="Read model", channel_id=None, guild_id=None,
        source_type="test", conversation_id="read-model",
    )


@contextmanager
def isolated_database_dsn():
    schema_name = f"read_model_{uuid.uuid4().hex}"
    with psycopg.connect(TEST_DSN, autocommit=True) as connection:
        connection.execute(f'CREATE SCHEMA "{schema_name}"')
    parameters = conninfo_to_dict(TEST_DSN)
    parameters["options"] = f"-c search_path={schema_name},public"
    try:
        yield make_conninfo(**parameters)
    finally:
        with psycopg.connect(TEST_DSN, autocommit=True) as connection:
            connection.execute(f'DROP SCHEMA "{schema_name}" CASCADE')
