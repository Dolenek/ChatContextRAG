import base64
import binascii
import json
from datetime import datetime
from typing import List, Optional, Tuple

import psycopg

from backend.models import (
    DatabaseBreakdowns, DatabaseChunkPage, DatabaseChunkView, DatabaseCount,
    DatabaseOverview, DatabaseStatus, IndexingJobView,
)
from backend.openai_gateway import ExternalIntegrationError


ACTIVE_INDEX_SQL = """(SELECT active_embedding_index_id
    FROM rag_application_settings WHERE id=1)"""


class DatabaseStatusReader:
    def read(self, connection: psycopg.Connection) -> DatabaseStatus:
        summary = self._read_primary_summary(connection)
        if not summary["raw_message_count"] and summary["total_chunks"]:
            summary.update(self._read_chunk_fallback(connection))
        database_size = connection.execute(
            "SELECT pg_size_pretty(pg_database_size(current_database()))"
        ).fetchone()[0]
        return DatabaseStatus(
            **summary, database_size=database_size,
            indexing_jobs=self._read_jobs(connection),
        )

    @staticmethod
    def _read_primary_summary(connection: psycopg.Connection) -> dict:
        row = connection.execute(f"""
            WITH raw_stats AS (
              SELECT COUNT(*) raw_count, COUNT(DISTINCT content_hash) unique_count,
                     COUNT(DISTINCT author) author_count,
                     COUNT(DISTINCT (source_type,conversation_id)) conversation_count,
                     MIN(sent_at) oldest, MAX(sent_at) newest
              FROM source_messages
            ), chunk_stats AS (
              SELECT COUNT(*) chunk_count FROM rag_chunks
              WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            ), indexed_stats AS (
              SELECT COUNT(DISTINCT message_id) indexed_count FROM rag_chunk_messages
              WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            )
            SELECT raw_count,unique_count,author_count,conversation_count,oldest,newest,
                   chunk_count,indexed_count FROM raw_stats,chunk_stats,indexed_stats
        """).fetchone()
        raw_count, unique_count, authors, channels, oldest, newest, chunks, indexed = row
        return {
            "total_chunks": chunks, "total_source_messages": raw_count,
            "total_channels": channels, "total_authors": authors,
            "oldest_message_at": oldest, "newest_message_at": newest,
            "raw_message_count": raw_count, "unique_content_count": unique_count,
            "duplicate_message_count": max(0, raw_count - unique_count),
            "indexed_message_count": indexed,
            "pending_message_count": max(0, raw_count - indexed),
        }

    @staticmethod
    def _read_chunk_fallback(connection: psycopg.Connection) -> dict:
        row = connection.execute(f"""
            WITH active_chunks AS MATERIALIZED (
              SELECT source_message_ids,authors,channel,started_at,ended_at FROM rag_chunks
              WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            )
            SELECT
              (SELECT COUNT(DISTINCT source_id) FROM active_chunks,
                 LATERAL UNNEST(source_message_ids) source_id),
              (SELECT COUNT(DISTINCT author_name) FROM active_chunks,
                 LATERAL UNNEST(authors) author_name),
              (SELECT COUNT(DISTINCT channel) FROM active_chunks),
              (SELECT MIN(started_at) FROM active_chunks),
              (SELECT MAX(ended_at) FROM active_chunks)
        """).fetchone()
        return {
            "total_source_messages": row[0], "total_authors": row[1],
            "total_channels": row[2], "oldest_message_at": row[3],
            "newest_message_at": row[4],
        }

    @staticmethod
    def _read_jobs(connection: psycopg.Connection) -> List[IndexingJobView]:
        rows = connection.execute("""
            SELECT job.id,job.session_id,job.status,job.total_messages,
                   job.processed_messages,job.stored_chunks,job.last_error,
                   job.started_at,job.finished_at,job.embedding_index_id,
                   idx.name,job.job_type
            FROM indexing_jobs job JOIN embedding_indexes idx
              ON idx.id=job.embedding_index_id
            ORDER BY job.created_at DESC LIMIT 10
        """).fetchall()
        return [DatabaseStatusReader._to_job(row) for row in rows]

    @staticmethod
    def _to_job(row: tuple) -> IndexingJobView:
        return IndexingJobView(
            job_id=row[0], session_id=row[1], status=row[2], total_messages=row[3],
            processed_messages=row[4], stored_chunks=row[5], last_error=row[6],
            started_at=row[7], finished_at=row[8], embedding_index_id=row[9],
            embedding_index_name=row[10], job_type=row[11],
        )


class DatabaseDetailReader:
    def read_breakdowns(self, connection: psycopg.Connection) -> DatabaseBreakdowns:
        return DatabaseBreakdowns(
            channels=self._read_counts(connection, self._channel_counts_sql()),
            authors=self._read_counts(connection, self._author_counts_sql()),
            embedding_models=self._read_counts(connection, self._model_counts_sql()),
        )

    def read_cursor_page(
        self, connection: psycopg.Connection, limit: int,
        cursor: Optional[Tuple[datetime, str]],
    ) -> DatabaseChunkPage:
        cursor_time, cursor_id = cursor or (None, None)
        rows = connection.execute(f"""
            SELECT id,content,authors,source_message_ids,channel,started_at,
                   ended_at,embedding_model,metadata,updated_at
            FROM rag_chunks
            WHERE embedding_index_id={ACTIVE_INDEX_SQL}
              AND (%s::timestamptz IS NULL OR (updated_at,id) < (%s,%s))
            ORDER BY updated_at DESC,id DESC LIMIT %s
        """, (cursor_time, cursor_time, cursor_id, limit + 1)).fetchall()
        has_more = len(rows) > limit
        visible_rows = rows[:limit]
        next_cursor = encode_chunk_cursor(visible_rows[-1][9], visible_rows[-1][0]) \
            if has_more and visible_rows else None
        return DatabaseChunkPage(
            chunks=[self._to_chunk(row) for row in visible_rows],
            has_more=has_more, next_cursor=next_cursor,
        )

    def read_offset_page(
        self, connection: psycopg.Connection, limit: int, offset: int,
    ) -> List[DatabaseChunkView]:
        rows = connection.execute(f"""
            SELECT id,content,authors,source_message_ids,channel,started_at,
                   ended_at,embedding_model,metadata,updated_at
            FROM rag_chunks WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            ORDER BY updated_at DESC,id DESC LIMIT %s OFFSET %s
        """, (limit, offset)).fetchall()
        return [self._to_chunk(row) for row in rows]

    @staticmethod
    def _read_counts(connection: psycopg.Connection, query: str) -> List[DatabaseCount]:
        return [DatabaseCount(label=row[0], count=row[1])
                for row in connection.execute(query).fetchall()]

    @staticmethod
    def _channel_counts_sql() -> str:
        return f"""SELECT COALESCE(channel,'Bez kanálu'),COUNT(*) FROM rag_chunks
            WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            GROUP BY channel ORDER BY COUNT(*) DESC,channel NULLS LAST"""

    @staticmethod
    def _author_counts_sql() -> str:
        return f"""SELECT author_name,COUNT(*) FROM rag_chunks,
            LATERAL UNNEST(authors) author_name
            WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            GROUP BY author_name ORDER BY COUNT(*) DESC,author_name"""

    @staticmethod
    def _model_counts_sql() -> str:
        return f"""SELECT embedding_model,COUNT(*) FROM rag_chunks
            WHERE embedding_index_id={ACTIVE_INDEX_SQL}
            GROUP BY embedding_model ORDER BY COUNT(*) DESC,embedding_model"""

    @staticmethod
    def _to_chunk(row: tuple) -> DatabaseChunkView:
        return DatabaseChunkView(
            chunk_id=row[0], content=row[1], authors=row[2], source_message_ids=row[3],
            channel=row[4], started_at=row[5], ended_at=row[6], embedding_model=row[7],
            metadata=row[8], updated_at=row[9],
        )


class PostgresOverviewReader:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn
        self.status_reader = DatabaseStatusReader()
        self.detail_reader = DatabaseDetailReader()

    def get_status(self) -> DatabaseStatus:
        return self._read(lambda connection: self.status_reader.read(connection))

    def get_breakdowns(self) -> DatabaseBreakdowns:
        return self._read(lambda connection: self.detail_reader.read_breakdowns(connection))

    def get_chunk_page(self, limit: int, cursor: Optional[str]) -> DatabaseChunkPage:
        decoded_cursor = decode_chunk_cursor(cursor) if cursor else None
        return self._read(lambda connection: self.detail_reader.read_cursor_page(
            connection, limit, decoded_cursor,
        ))

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        def assemble(connection: psycopg.Connection) -> DatabaseOverview:
            status = self.status_reader.read(connection)
            breakdowns = self.detail_reader.read_breakdowns(connection)
            chunks = self.detail_reader.read_offset_page(connection, limit, offset)
            return DatabaseOverview(
                **status.model_dump(), **breakdowns.model_dump(), chunks=chunks,
                limit=limit, offset=offset,
                has_more=offset + len(chunks) < status.total_chunks,
            )
        return self._read(assemble)

    def _read(self, operation):
        try:
            with psycopg.connect(self.database_dsn) as connection:
                return operation(connection)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL overview query failed.") from error


def encode_chunk_cursor(updated_at: datetime, chunk_id: str) -> str:
    payload = json.dumps({"updated_at": updated_at.isoformat(), "id": chunk_id})
    return base64.urlsafe_b64encode(payload.encode("utf8")).decode("ascii").rstrip("=")


def decode_chunk_cursor(cursor: str) -> Tuple[datetime, str]:
    try:
        padding = "=" * (-len(cursor) % 4)
        payload = json.loads(base64.urlsafe_b64decode(cursor + padding).decode("utf8"))
        updated_at = datetime.fromisoformat(payload["updated_at"].replace("Z", "+00:00"))
        chunk_id = payload["id"]
        if updated_at.tzinfo is None or not isinstance(chunk_id, str) or not chunk_id:
            raise ValueError
        return updated_at, chunk_id
    except (binascii.Error, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise ValueError("Invalid database chunk cursor.") from error
