import os
import uuid

import psycopg
import pytest
from pgvector import HalfVector
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb

from backend.hybrid_repository import PostgresHybridRepository
from backend.models import IngestionSessionRequest
from backend.migration_exports import MigrationExportService
from backend.raw_message_writer import RawMessageWriter
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import ConversationChunk, EmbeddedChunk, NormalizedMessage


TEST_DSN = os.environ.get("POSTGRES_TEST_DSN")


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_migrated_schema_accepts_whatsapp_session_without_discord_ids() -> None:
    repository = PostgresRawMessageRepository(TEST_DSN)
    repository.ensure_schema()

    session = repository.create_session(IngestionSessionRequest(
        source_type="whatsapp", conversation_id="family",
        conversation_label="Family",
    ))

    try:
        with psycopg.connect(TEST_DSN) as connection:
            row = connection.execute(
                "SELECT guild_id,channel_id,source_type FROM ingestion_sessions WHERE id=%s",
                (session.session_id,),
            ).fetchone()
        assert row == (None, None, "whatsapp")
    finally:
        repository.delete_session(session.session_id)


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
        hybrid_repository.ensure_model_index(values.index_id, 2)
        replacement = _replacement_chunk(values)
        hybrid_repository.prepare_staging(
            values.job_id, values.worker_id, values.index_id,
        )
        hybrid_repository.stage_chunks(
            values.job_id, values.worker_id, values.index_id, [replacement],
        )

        assert _chunk_ids(TEST_DSN, values) == [values.old_chunk_id]
        assert hybrid_repository.commit_staged_chunks(
            values.job_id, values.session_id, values.worker_id,
            values.index_id, "incremental",
        )
        assert _chunk_ids(TEST_DSN, values) == [values.new_chunk_id]
        assert _untouched_chunk_exists(TEST_DSN, values)
        assert raw_repository.get_job(values.job_id).status == "completed"
        retrieved = hybrid_repository.search_hybrid(
            values.identity, [0.2, 0.1], 1,
            embedding_index_id=values.index_id, dimensions=2,
        )
        assert retrieved[0].source_message_ids == [values.message_id]
        assert retrieved[0].channel_id == "20"
        assert retrieved[0].guild_id == "10"
    finally:
        _cleanup(TEST_DSN, values)


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_finished_session_fans_out_to_every_auto_sync_index() -> None:
    identity = uuid.uuid4().hex
    index_ids = [f"fanout-a-{identity}", f"fanout-b-{identity}"]
    repository = PostgresRawMessageRepository(TEST_DSN)
    repository.ensure_schema()
    with psycopg.connect(TEST_DSN) as connection:
        for index_id in index_ids:
            connection.execute(
                """INSERT INTO embedding_indexes
                   (id,name,provider_id,model,dimensions,status,auto_sync)
                   VALUES(%s,%s,'openai','test',2,'ready',TRUE)""",
                (index_id, index_id),
            )
    session = repository.create_session(IngestionSessionRequest(
        source_type="test", conversation_id=identity,
    ))
    try:
        finished = repository.finish_session(session.session_id, "completed")
        with psycopg.connect(TEST_DSN) as connection:
            job_indexes = {row[0] for row in connection.execute(
                "SELECT embedding_index_id FROM indexing_jobs WHERE session_id=%s",
                (session.session_id,),
            ).fetchall()}
        assert set(index_ids).issubset(job_indexes)
        assert len(finished.indexing_job_ids) == len(job_indexes)
    finally:
        repository.delete_session(session.session_id)
        with psycopg.connect(TEST_DSN) as connection:
            connection.execute("DELETE FROM embedding_indexes WHERE id=ANY(%s)", (index_ids,))


@pytest.mark.skipif(not TEST_DSN, reason="POSTGRES_TEST_DSN is not configured")
def test_migration_snapshot_is_stable_and_can_finish_without_indexing() -> None:
    identity = f"zz-migration-{uuid.uuid4().hex}"
    first_id, later_id = f"{identity}-a", f"{identity}-b"
    repository = PostgresRawMessageRepository(TEST_DSN)
    repository.ensure_schema()
    source_session = repository.create_session(IngestionSessionRequest(
        source_type="test", conversation_id=identity,
    ))
    exports = MigrationExportService(repository.ensure_schema, repository.open_connection)
    snapshot = None
    try:
        repository.store_messages(source_session.session_id, [_raw_message(first_id, 1)])
        snapshot = exports.create_snapshot()
        repository.store_messages(source_session.session_id, [_raw_message(later_id, 2)])
        page = exports.get_page(snapshot.export_id, identity, 400)

        assert first_id in {message.external_id for message in page.messages}
        assert later_id not in {message.external_id for message in page.messages}
        completed = repository.finish_session(
            source_session.session_id, "completed", queue_indexing=False,
        )
        assert completed.indexing_job_ids == []
    finally:
        if snapshot:
            exports.delete_snapshot(snapshot.export_id)
        repository.delete_session(source_session.session_id)
        with psycopg.connect(TEST_DSN) as connection:
            connection.execute(
                "DELETE FROM source_messages WHERE external_id=ANY(%s)",
                ([first_id, later_id],),
            )
            connection.execute(
                "DELETE FROM message_contents WHERE content_hash=ANY(%s)",
                ([RawMessageWriter.content_hash(f"content {first_id}"),
                  RawMessageWriter.content_hash(f"content {later_id}")],),
            )


def _raw_message(external_id: str, order: int) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=external_id, author="Ada", content=f"content {external_id}",
        timestamp=None, channel="migration", channel_id=None, guild_id=None,
        source_type="test", conversation_id="migration", message_order=order,
    )


class _TestIdentity:
    def __init__(self, identity: str) -> None:
        self.identity = identity
        self.message_id = str(int(identity[:15], 16))
        self.content_hash = RawMessageWriter.content_hash(identity)
        self.untouched_message_id = str(int(identity[15:30], 16))
        self.untouched_content_hash = RawMessageWriter.content_hash(identity + "-untouched")
        self.session_id = f"session-{identity}"
        self.job_id = f"job-{identity}"
        self.worker_id = f"worker-{identity}"
        self.index_id = f"index-{identity}"
        self.old_chunk_id = f"old-{identity}"
        self.new_chunk_id = f"new-{identity}"
        self.untouched_chunk_id = f"untouched-{identity}"


def _seed_old_index(database_dsn: str, values: _TestIdentity) -> None:
    with _connection(database_dsn) as connection:
        connection.execute(
            """INSERT INTO embedding_indexes
               (id,name,provider_id,model,dimensions,status,auto_sync)
               VALUES(%s,'Test','openai','test',2,'ready',FALSE)""", (values.index_id,),
        )
        connection.execute(
            "INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)",
            (values.content_hash, values.identity),
        )
        connection.execute(
            "INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)",
            (values.untouched_content_hash, values.identity + "-untouched"),
        )
        connection.execute(
            """INSERT INTO source_messages
               (external_id,message_order,author,content_hash,channel_id,guild_id)
               VALUES (%s,%s,'Ada',%s,'20','10')""",
            (values.message_id, int(values.message_id), values.content_hash),
        )
        connection.execute(
            """INSERT INTO source_messages
               (external_id,message_order,author,content_hash,channel_id,guild_id)
               VALUES (%s,%s,'Bob',%s,'20','10')""",
            (
                values.untouched_message_id, int(values.untouched_message_id),
                values.untouched_content_hash,
            ),
        )
        connection.execute(
            """INSERT INTO ingestion_sessions(id,guild_id,channel_id,status)
               VALUES (%s,'10','20','completed')""", (values.session_id,),
        )
        connection.execute(
            "INSERT INTO ingestion_session_messages VALUES (%s,%s)",
            (values.session_id, values.message_id),
        )
        connection.execute(
            "INSERT INTO ingestion_session_messages VALUES (%s,%s)",
            (values.session_id, values.untouched_message_id),
        )
        _insert_running_job(connection, values)
        _insert_old_chunk(connection, values)


def _insert_running_job(connection, values: _TestIdentity) -> None:
    connection.execute(
        """INSERT INTO indexing_jobs
           (id,session_id,embedding_index_id,status,worker_id,lease_expires_at)
           VALUES (%s,%s,%s,'running',%s,NOW()+INTERVAL '5 minutes')""",
        (values.job_id, values.session_id, values.index_id, values.worker_id),
    )
    connection.execute(
        "INSERT INTO indexing_job_messages(job_id,message_id) VALUES (%s,%s)",
        (values.job_id, values.message_id),
    )


def _insert_old_chunk(connection, values: _TestIdentity) -> None:
    connection.execute(
        """INSERT INTO rag_chunks
           (embedding_index_id,id,content,authors,source_message_ids,
            embedding_model,embedding,metadata)
           VALUES (%s,%s,'old',ARRAY['Ada'],ARRAY[%s],'test',%s,%s)""",
        (values.index_id, values.old_chunk_id, values.message_id,
         HalfVector([0.1, 0.2]), Jsonb({})),
    )
    connection.execute(
        """INSERT INTO rag_chunk_messages
           (embedding_index_id,chunk_id,message_id,position) VALUES (%s,%s,%s,0)""",
        (values.index_id, values.old_chunk_id, values.message_id),
    )
    connection.execute(
        """INSERT INTO rag_chunks
           (embedding_index_id,id,content,authors,source_message_ids,
            embedding_model,embedding,metadata)
           VALUES (%s,%s,'untouched',ARRAY['Bob'],ARRAY[%s],'test',%s,%s)""",
        (
            values.index_id, values.untouched_chunk_id, values.untouched_message_id,
            HalfVector([0.9, 0.1]), Jsonb({}),
        ),
    )
    connection.execute(
        """INSERT INTO rag_chunk_messages
           (embedding_index_id,chunk_id,message_id,position) VALUES (%s,%s,%s,0)""",
        (values.index_id, values.untouched_chunk_id, values.untouched_message_id),
    )


def _replacement_chunk(values: _TestIdentity) -> EmbeddedChunk:
    chunk = ConversationChunk(
        chunk_id=values.new_chunk_id, content=values.identity, authors=["Ada"],
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


def _untouched_chunk_exists(database_dsn: str, values: _TestIdentity) -> bool:
    with _connection(database_dsn) as connection:
        row = connection.execute(
            "SELECT EXISTS(SELECT 1 FROM rag_chunks WHERE id=%s)",
            (values.untouched_chunk_id,),
        ).fetchone()
    return bool(row[0])


def _cleanup(database_dsn: str, values: _TestIdentity) -> None:
    with _connection(database_dsn) as connection:
        connection.execute(
            "DELETE FROM rag_chunks WHERE id=ANY(%s)",
            ([values.old_chunk_id, values.new_chunk_id, values.untouched_chunk_id],),
        )
        connection.execute("DELETE FROM indexing_jobs WHERE id=%s", (values.job_id,))
        connection.execute("DELETE FROM embedding_indexes WHERE id=%s", (values.index_id,))
        connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (values.session_id,))
        connection.execute(
            "DELETE FROM source_messages WHERE external_id=ANY(%s)",
            ([values.message_id, values.untouched_message_id],),
        )
        connection.execute(
            "DELETE FROM message_contents WHERE content_hash=ANY(%s)",
            ([values.content_hash, values.untouched_content_hash],),
        )
        connection.execute(
            psycopg.sql.SQL("DROP INDEX IF EXISTS {}").format(psycopg.sql.Identifier(
                "rag_embedding_" + values.index_id.replace("-", "_") + "_hnsw"
            )),
        )


def _connection(database_dsn: str):
    connection = psycopg.connect(database_dsn)
    register_vector(connection)
    return connection
