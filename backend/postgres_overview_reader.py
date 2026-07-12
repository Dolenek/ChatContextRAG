from typing import List

import psycopg

from backend.models import DatabaseChunkView, DatabaseCount, DatabaseOverview
from backend.openai_gateway import ExternalIntegrationError


class PostgresOverviewReader:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        try:
            with psycopg.connect(self.database_dsn) as connection:
                table = self._active_chunk_table(connection)
                summary = self._read_summary(connection, table)
                raw_summary = self._read_raw_summary(connection)
                channels = self._read_counts(connection, self._channel_counts_sql(table))
                authors = self._read_counts(connection, self._author_counts_sql(table))
                models = self._read_counts(connection, self._model_counts_sql(table))
                chunks = self._read_chunks(connection, table, limit, offset)
                jobs = self._read_jobs(connection)
                database_size = connection.execute(
                    "SELECT pg_size_pretty(pg_database_size(current_database()))"
                ).fetchone()[0]
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL overview query failed.") from error
        combined_summary = {**summary, **raw_summary}
        return DatabaseOverview(
            **combined_summary, channels=channels, authors=authors, embedding_models=models,
            chunks=chunks, limit=limit, offset=offset,
            has_more=offset + len(chunks) < summary["total_chunks"],
            database_size=database_size, indexing_jobs=jobs,
        )

    @staticmethod
    def _read_summary(connection: psycopg.Connection, table: str) -> dict:
        main_row = connection.execute(
            f"""
            SELECT COUNT(*), COUNT(DISTINCT channel), MIN(started_at), MAX(ended_at)
            FROM {table}
            """
        ).fetchone()
        source_count = PostgresOverviewReader._source_count(connection, table)
        author_count = connection.execute(
            f"""
            SELECT COUNT(DISTINCT author_name) FROM {table},
            LATERAL UNNEST(authors) AS author_name
            """
        ).fetchone()[0]
        return {
            "total_chunks": main_row[0], "total_source_messages": source_count,
            "total_channels": main_row[1], "total_authors": author_count,
            "oldest_message_at": main_row[2], "newest_message_at": main_row[3],
        }

    @staticmethod
    def _read_counts(connection: psycopg.Connection, query: str) -> List[DatabaseCount]:
        rows = connection.execute(query).fetchall()
        return [DatabaseCount(label=row[0], count=row[1]) for row in rows]

    @staticmethod
    def _read_chunks(
        connection: psycopg.Connection, table: str, limit: int, offset: int
    ) -> List[DatabaseChunkView]:
        rows = connection.execute(
            f"""
            SELECT id, content, authors, source_message_ids, channel, started_at,
                   ended_at, embedding_model, metadata, updated_at
            FROM {table} ORDER BY updated_at DESC LIMIT %s OFFSET %s
            """,
            (limit, offset),
        ).fetchall()
        return [PostgresOverviewReader._to_chunk_view(row) for row in rows]

    @staticmethod
    def _to_chunk_view(row: tuple) -> DatabaseChunkView:
        return DatabaseChunkView(
            chunk_id=row[0], content=row[1], authors=row[2], source_message_ids=row[3],
            channel=row[4], started_at=row[5], ended_at=row[6], embedding_model=row[7],
            metadata=row[8], updated_at=row[9],
        )

    @staticmethod
    def _channel_counts_sql(table: str) -> str:
        return f"""
            SELECT COALESCE(channel, 'Bez kanálu'), COUNT(*) FROM {table}
            GROUP BY channel ORDER BY COUNT(*) DESC, channel NULLS LAST
        """

    @staticmethod
    def _author_counts_sql(table: str) -> str:
        return f"""
            SELECT author_name, COUNT(*) FROM {table},
            LATERAL UNNEST(authors) AS author_name
            GROUP BY author_name ORDER BY COUNT(*) DESC, author_name
        """

    @staticmethod
    def _model_counts_sql(table: str) -> str:
        return f"""
            SELECT embedding_model, COUNT(*) FROM {table}
            GROUP BY embedding_model ORDER BY COUNT(*) DESC, embedding_model
        """

    @staticmethod
    def _active_chunk_table(connection) -> str:
        has_rag = connection.execute("SELECT EXISTS(SELECT 1 FROM rag_chunks)").fetchone()[0]
        return "rag_chunks" if has_rag else "conversation_chunks"

    @staticmethod
    def _source_count(connection, table: str) -> int:
        return connection.execute(
            f"""SELECT COUNT(DISTINCT source_id) FROM {table},
                 LATERAL UNNEST(source_message_ids) AS source_id"""
        ).fetchone()[0]

    @staticmethod
    def _read_raw_summary(connection) -> dict:
        raw_count, unique_count, oldest, newest, authors, channels = connection.execute(
            """SELECT COUNT(*),COUNT(DISTINCT content_hash),MIN(sent_at),MAX(sent_at),
                      COUNT(DISTINCT author),
                      COUNT(DISTINCT (source_type,conversation_id))
               FROM source_messages"""
        ).fetchone()
        indexed = connection.execute(
            "SELECT COUNT(DISTINCT message_id) FROM rag_chunk_messages"
        ).fetchone()[0]
        return {
            "raw_message_count": raw_count, "unique_content_count": unique_count,
            "duplicate_message_count": max(0, raw_count - unique_count),
            "indexed_message_count": indexed,
            "pending_message_count": max(0, raw_count - indexed),
            **({
                "total_source_messages": raw_count, "total_authors": authors,
                "total_channels": channels, "oldest_message_at": oldest,
                "newest_message_at": newest,
            } if raw_count else {}),
        }

    @staticmethod
    def _read_jobs(connection):
        from backend.models import IndexingJobView
        rows = connection.execute(
            """SELECT id,session_id,status,total_messages,processed_messages,
                      stored_chunks,last_error,started_at,finished_at
               FROM indexing_jobs ORDER BY created_at DESC LIMIT 10"""
        ).fetchall()
        return [IndexingJobView(
            job_id=row[0], session_id=row[1], status=row[2], total_messages=row[3],
            processed_messages=row[4], stored_chunks=row[5], last_error=row[6],
            started_at=row[7], finished_at=row[8],
        ) for row in rows]
