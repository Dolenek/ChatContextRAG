import os
import uuid

import psycopg
import pytest
from pgvector import HalfVector
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb

from backend.hybrid_repository import PostgresHybridRepository
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import ConversationChunk, EmbeddedChunk


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_staged_index_replacement_is_atomic_in_postgres() -> None:
    identity = uuid.uuid4().hex
    values = _TestIdentity(identity)
    raw_repository = PostgresRawMessageRepository(TEST_DSN)
    hybrid_repository = PostgresHybridRepository(TEST_DSN, 2)
    raw_repository.ensure_schema()
    hybrid_repository.ensure_schema()
    try:
        _seed_old_index(TEST_DSN, values)
        replacement = _replacement_chunk(values)
        hybrid_repository.prepare_staging(values.job_id, values.worker_id)
        hybrid_repository.stage_chunks(
            values.job_id, values.worker_id, [replacement],
        )

        assert _chunk_ids(TEST_DSN, values) == [values.old_chunk_id]
        assert hybrid_repository.commit_staged_chunks(
            values.job_id, values.session_id, values.worker_id,
        )
        assert _chunk_ids(TEST_DSN, values) == [values.new_chunk_id]
        assert raw_repository.get_job(values.job_id).status == "completed"
        retrieved = hybrid_repository.search_hybrid("replacement", [0.2, 0.1], 1)
        assert retrieved[0].source_message_ids == [values.message_id]
        assert retrieved[0].channel_id == "20"
        assert retrieved[0].guild_id == "10"
    finally:
        _cleanup(TEST_DSN, values)


class _TestIdentity:
    def __init__(self, identity: str) -> None:
        self.message_id = str(int(identity[:15], 16))
        self.content_hash = RawMessageWriter.content_hash(identity)
        self.session_id = f"session-{identity}"
        self.job_id = f"job-{identity}"
        self.worker_id = f"worker-{identity}"
        self.old_chunk_id = f"old-{identity}"
        self.new_chunk_id = f"new-{identity}"


def _seed_old_index(database_dsn: str, values: _TestIdentity) -> None:
    with _connection(database_dsn) as connection:
        connection.execute(
            "INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)",
            (values.content_hash, "old content"),
        )
        connection.execute(
            """INSERT INTO discord_messages
               (external_id,message_order,author,content_hash,channel_id,guild_id)
               VALUES (%s,%s,'Ada',%s,'20','10')""",
            (values.message_id, int(values.message_id), values.content_hash),
        )
        connection.execute(
            """INSERT INTO ingestion_sessions(id,guild_id,channel_id,status)
               VALUES (%s,'10','20','completed')""", (values.session_id,),
        )
        connection.execute(
            "INSERT INTO ingestion_session_messages VALUES (%s,%s)",
            (values.session_id, values.message_id),
        )
        _insert_running_job(connection, values)
        _insert_old_chunk(connection, values)


def _insert_running_job(connection, values: _TestIdentity) -> None:
    connection.execute(
        """INSERT INTO indexing_jobs(id,session_id,status,worker_id,lease_expires_at)
           VALUES (%s,%s,'running',%s,NOW()+INTERVAL '5 minutes')""",
        (values.job_id, values.session_id, values.worker_id),
    )


def _insert_old_chunk(connection, values: _TestIdentity) -> None:
    connection.execute(
        """INSERT INTO rag_chunks
           (id,content,authors,source_message_ids,embedding_model,embedding,metadata)
           VALUES (%s,'old',ARRAY['Ada'],ARRAY[%s],'test',%s,%s)""",
        (values.old_chunk_id, values.message_id, HalfVector([0.1, 0.2]), Jsonb({})),
    )
    connection.execute(
        "INSERT INTO rag_chunk_messages VALUES (%s,%s,0)",
        (values.old_chunk_id, values.message_id),
    )


def _replacement_chunk(values: _TestIdentity) -> EmbeddedChunk:
    chunk = ConversationChunk(
        chunk_id=values.new_chunk_id, content="new", authors=["Ada"],
        source_message_ids=[values.message_id], channel="guide",
        started_at=None, ended_at=None,
        metadata={"channel_id": "20", "guild_id": "10"},
    )
    return EmbeddedChunk(chunk=chunk, embedding=[0.2, 0.1], embedding_model="test")


def _chunk_ids(database_dsn: str, values: _TestIdentity) -> list:
    with _connection(database_dsn) as connection:
        rows = connection.execute(
            "SELECT id FROM rag_chunks WHERE id=ANY(%s) ORDER BY id",
            ([values.old_chunk_id, values.new_chunk_id],),
        ).fetchall()
    return [row[0] for row in rows]


def _cleanup(database_dsn: str, values: _TestIdentity) -> None:
    with _connection(database_dsn) as connection:
        connection.execute(
            "DELETE FROM rag_chunks WHERE id=ANY(%s)",
            ([values.old_chunk_id, values.new_chunk_id],),
        )
        connection.execute("DELETE FROM indexing_jobs WHERE id=%s", (values.job_id,))
        connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (values.session_id,))
        connection.execute("DELETE FROM discord_messages WHERE external_id=%s", (values.message_id,))
        connection.execute("DELETE FROM message_contents WHERE content_hash=%s", (values.content_hash,))


def _connection(database_dsn: str):
    connection = psycopg.connect(database_dsn)
    register_vector(connection)
    return connection
