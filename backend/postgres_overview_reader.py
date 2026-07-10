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
                summary = self._read_summary(connection)
                channels = self._read_counts(connection, self._channel_counts_sql())
                authors = self._read_counts(connection, self._author_counts_sql())
                models = self._read_counts(connection, self._model_counts_sql())
                chunks = self._read_chunks(connection, limit, offset)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL overview query failed.") from error
        return DatabaseOverview(
            **summary, channels=channels, authors=authors, embedding_models=models,
            chunks=chunks, limit=limit, offset=offset,
            has_more=offset + len(chunks) < summary["total_chunks"],
        )

    @staticmethod
    def _read_summary(connection: psycopg.Connection) -> dict:
        main_row = connection.execute(
            """
            SELECT COUNT(*), COUNT(DISTINCT channel), MIN(started_at), MAX(ended_at)
            FROM conversation_chunks
            """
        ).fetchone()
        source_count = connection.execute(
            """
            SELECT COUNT(DISTINCT source_id) FROM conversation_chunks,
            LATERAL UNNEST(source_message_ids) AS source_id
            """
        ).fetchone()[0]
        author_count = connection.execute(
            """
            SELECT COUNT(DISTINCT author_name) FROM conversation_chunks,
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
        connection: psycopg.Connection, limit: int, offset: int
    ) -> List[DatabaseChunkView]:
        rows = connection.execute(
            """
            SELECT id, content, authors, source_message_ids, channel, started_at,
                   ended_at, embedding_model, metadata, updated_at
            FROM conversation_chunks ORDER BY updated_at DESC LIMIT %s OFFSET %s
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
    def _channel_counts_sql() -> str:
        return """
            SELECT COALESCE(channel, 'Bez kanálu'), COUNT(*) FROM conversation_chunks
            GROUP BY channel ORDER BY COUNT(*) DESC, channel NULLS LAST
        """

    @staticmethod
    def _author_counts_sql() -> str:
        return """
            SELECT author_name, COUNT(*) FROM conversation_chunks,
            LATERAL UNNEST(authors) AS author_name
            GROUP BY author_name ORDER BY COUNT(*) DESC, author_name
        """

    @staticmethod
    def _model_counts_sql() -> str:
        return """
            SELECT embedding_model, COUNT(*) FROM conversation_chunks
            GROUP BY embedding_model ORDER BY COUNT(*) DESC, embedding_model
        """
