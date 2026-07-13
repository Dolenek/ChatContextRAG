from typing import Callable, Iterable

import numpy as np
import psycopg
from pgvector import HalfVector
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb

from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import EmbeddedChunk


class PostgresIndexStaging:
    def __init__(self, database_dsn: str, ensure_schema: Callable[[], None]) -> None:
        self.database_dsn = database_dsn
        self.ensure_schema = ensure_schema

    def prepare(self, job_id: str, worker_id: str, embedding_index_id: str) -> None:
        self.ensure_schema()
        with self._connect() as connection:
            self._assert_owned_job(connection, job_id, worker_id, embedding_index_id)
            connection.execute("DELETE FROM rag_staged_chunks WHERE job_id=%s", (job_id,))

    def stage(
        self, job_id: str, worker_id: str, embedding_index_id: str,
        chunks: Iterable[EmbeddedChunk],
    ) -> int:
        chunk_list = list(chunks)
        if not chunk_list:
            return 0
        self.ensure_schema()
        try:
            with self._connect() as connection, connection.cursor() as cursor:
                self._assert_owned_job(connection, job_id, worker_id, embedding_index_id)
                rows = [(job_id, embedding_index_id, *self._to_row(item)) for item in chunk_list]
                cursor.executemany(self._upsert_sql(), rows)
                self._replace_batch_links(
                    cursor, job_id, embedding_index_id, chunk_list,
                )
            return len(chunk_list)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL halfvec staging failed.") from error

    @staticmethod
    def _assert_owned_job(
        connection, job_id: str, worker_id: str,
        embedding_index_id: str = "default-openai",
    ) -> None:
        row = connection.execute(
            """SELECT 1 FROM indexing_jobs WHERE id=%s AND status='running'
               AND worker_id=%s AND embedding_index_id=%s FOR SHARE""",
            (job_id, worker_id, embedding_index_id),
        ).fetchone()
        if not row:
            raise RuntimeError("Indexing job lease is no longer owned by this worker.")

    def commit(
        self, job_id: str, session_id: str, worker_id: str,
        embedding_index_id: str, job_type: str,
    ) -> bool:
        self.ensure_schema()
        try:
            with self._connect() as connection:
                status_row = connection.execute(
                    """SELECT status FROM indexing_jobs WHERE id=%s AND worker_id=%s
                       FOR UPDATE""", (job_id, worker_id),
                ).fetchone()
                if not status_row or status_row[0] != "running":
                    return False
                self._replace_session_chunks(
                    connection, job_id, session_id, embedding_index_id, job_type,
                )
                connection.execute(
                    """UPDATE indexing_jobs SET status='completed',
                       processed_messages=total_messages, finished_at=NOW(), last_error=NULL,
                       worker_id=NULL, lease_expires_at=NULL
                       WHERE id=%s""", (job_id,),
                )
            return True
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL index commit failed.") from error

    @staticmethod
    def create_schema_sql() -> str:
        return """CREATE TABLE IF NOT EXISTS rag_staged_chunks (
            job_id TEXT REFERENCES indexing_jobs(id) ON DELETE CASCADE,
            embedding_index_id TEXT NOT NULL,
            id TEXT NOT NULL, content TEXT NOT NULL, authors TEXT[] NOT NULL,
            source_message_ids TEXT[] NOT NULL, channel TEXT, started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ, embedding_model TEXT NOT NULL,
            embedding halfvec NOT NULL, metadata JSONB NOT NULL DEFAULT '{}',
            PRIMARY KEY(job_id,id));
            CREATE TABLE IF NOT EXISTS rag_staged_chunk_messages (
            job_id TEXT NOT NULL, embedding_index_id TEXT NOT NULL, chunk_id TEXT NOT NULL,
            message_id TEXT REFERENCES source_messages(external_id) ON DELETE CASCADE,
            position INTEGER NOT NULL, PRIMARY KEY(job_id,chunk_id,message_id),
            FOREIGN KEY(job_id,chunk_id) REFERENCES rag_staged_chunks(job_id,id)
              ON DELETE CASCADE)"""

    @staticmethod
    def _upsert_sql() -> str:
        return """INSERT INTO rag_staged_chunks
            (job_id,embedding_index_id,id,content,authors,source_message_ids,channel,
             started_at,ended_at,embedding_model,embedding,metadata)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(job_id,id) DO UPDATE SET content=EXCLUDED.content,
              authors=EXCLUDED.authors, source_message_ids=EXCLUDED.source_message_ids,
              channel=EXCLUDED.channel, started_at=EXCLUDED.started_at,
              ended_at=EXCLUDED.ended_at, embedding_model=EXCLUDED.embedding_model,
              embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata"""

    @staticmethod
    def _replace_batch_links(
        cursor, job_id: str, embedding_index_id: str,
        chunks: Iterable[EmbeddedChunk],
    ) -> None:
        chunk_list = list(chunks)
        cursor.execute(
            "DELETE FROM rag_staged_chunk_messages WHERE job_id=%s AND chunk_id=ANY(%s)",
            (job_id, [item.chunk.chunk_id for item in chunk_list]),
        )
        link_rows = [
            (job_id, embedding_index_id, item.chunk.chunk_id, message_id, position)
            for item in chunk_list
            for position, message_id in enumerate(item.chunk.source_message_ids)
        ]
        cursor.executemany(
            """INSERT INTO rag_staged_chunk_messages
               (job_id,embedding_index_id,chunk_id,message_id,position)
               VALUES (%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING""",
            link_rows,
        )

    @staticmethod
    def _replace_session_chunks(
        connection, job_id: str, session_id: str,
        embedding_index_id: str, job_type: str,
    ) -> None:
        if job_type == "rebuild":
            connection.execute(
                "DELETE FROM rag_chunks WHERE embedding_index_id=%s",
                (embedding_index_id,),
            )
        else:
            connection.execute(
                """DELETE FROM rag_chunks WHERE embedding_index_id=%s AND id IN (
                 SELECT DISTINCT cm.chunk_id FROM rag_chunk_messages cm
                 JOIN indexing_job_messages jm ON jm.message_id=cm.message_id
                 WHERE cm.embedding_index_id=%s AND jm.job_id=%s)""",
                (embedding_index_id, embedding_index_id, job_id),
            )
        connection.execute(PostgresIndexStaging._commit_sql(), (job_id,))
        connection.execute(
            """DELETE FROM rag_chunk_messages WHERE embedding_index_id=%s AND chunk_id IN
               (SELECT id FROM rag_staged_chunks WHERE job_id=%s)""",
            (embedding_index_id, job_id),
        )
        connection.execute(
            """INSERT INTO rag_chunk_messages
               (embedding_index_id,chunk_id,message_id,position)
               SELECT embedding_index_id,chunk_id,message_id,position FROM rag_staged_chunk_messages
               WHERE job_id=%s""", (job_id,),
        )
        connection.execute("DELETE FROM rag_staged_chunks WHERE job_id=%s", (job_id,))

    @staticmethod
    def _commit_sql() -> str:
        return """INSERT INTO rag_chunks
            (embedding_index_id,id,content,authors,source_message_ids,channel,started_at,ended_at,
             embedding_model,embedding,metadata)
            SELECT embedding_index_id,id,content,authors,source_message_ids,channel,started_at,ended_at,
                   embedding_model,embedding,metadata
            FROM rag_staged_chunks WHERE job_id=%s
            ON CONFLICT(embedding_index_id,id) DO UPDATE SET content=EXCLUDED.content,
              authors=EXCLUDED.authors, source_message_ids=EXCLUDED.source_message_ids,
              channel=EXCLUDED.channel, started_at=EXCLUDED.started_at,
              ended_at=EXCLUDED.ended_at, embedding_model=EXCLUDED.embedding_model,
              embedding=EXCLUDED.embedding, metadata=EXCLUDED.metadata, updated_at=NOW()"""

    @staticmethod
    def _to_row(item: EmbeddedChunk) -> tuple:
        chunk = item.chunk
        return (
            chunk.chunk_id, chunk.content, chunk.authors, chunk.source_message_ids,
            chunk.channel, chunk.started_at, chunk.ended_at, item.embedding_model,
            HalfVector(np.asarray(item.embedding, dtype=np.float16)), Jsonb(chunk.metadata),
        )

    def _connect(self):
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection
