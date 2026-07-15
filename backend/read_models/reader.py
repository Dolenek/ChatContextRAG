from typing import Optional

import psycopg

from backend.chat_models import ChatScopeList
from backend.database_models import DatabaseCount, DatabaseCountPage
from backend.models import ChatScopeOption
from backend.read_models.metadata import (
    ReadModelMetadata, combine_metadata, metadata_from_state,
)
from backend.read_models.schema import ARCHIVE_PROJECTION_KEY


ARCHIVE_BREAKDOWN_DIMENSIONS = frozenset({"channels", "authors"})


class PostgresReadModelReader:
    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn

    def archive_summary(self, connection) -> tuple[dict, ReadModelMetadata]:
        values, exists = self._archive_values(connection)
        return values, self._metadata(connection, ARCHIVE_PROJECTION_KEY, exists)

    def index_summary(
        self, connection, index_id: Optional[str],
    ) -> tuple[dict, ReadModelMetadata]:
        if not index_id:
            return self._empty_index(), ReadModelMetadata(
                ready=True, stale=False, refreshing=False,
            )
        values, exists = self._index_values(connection, index_id)
        return values, self._metadata(connection, f"index:{index_id}", exists)

    def active_summary(self, connection) -> tuple[dict, ReadModelMetadata]:
        index_id = self.active_index_id(connection)
        archive, _ = self._archive_values(connection)
        index = self._empty_index()
        if index_id:
            index, _ = self._index_values(connection, index_id)
        raw_count = archive["raw_message_count"]
        values = {
            **archive, **index, "total_source_messages": raw_count,
            "duplicate_message_count": max(
                0, raw_count - archive["unique_content_count"],
            ),
        }
        return values, self.workspace_metadata(connection)

    def workspace_metadata(self, connection) -> ReadModelMetadata:
        rows = connection.execute("""SELECT state.requested_revision,
            state.published_revision,state.status,state.generated_at,state.last_error,
            CASE WHEN state.projection_kind='archive'
              THEN EXISTS(SELECT 1 FROM workspace_read_summary WHERE id=1)
              ELSE EXISTS(SELECT 1 FROM embedding_index_read_summary summary
                          WHERE summary.embedding_index_id=state.embedding_index_id)
            END snapshot_exists
            FROM read_model_refresh_state state""").fetchall()
        return combine_metadata(
            metadata_from_state(row[:5], row[5]) for row in rows
        )

    def scopes(self, connection) -> ChatScopeList:
        index_id = self.active_index_id(connection)
        rows = connection.execute("""SELECT source_type,conversation_id,display_name,
            container_name,message_count FROM chat_scope_read_model
            WHERE embedding_index_id=%s ORDER BY source_type,LOWER(display_name),conversation_id""",
            (index_id,),
        ).fetchall() if index_id else []
        _, metadata = self.index_summary(connection, index_id)
        scopes = [ChatScopeOption(
            source_type=row[0], conversation_id=row[1], display_name=row[2],
            container_name=row[3], message_count=row[4],
        ) for row in rows]
        return ChatScopeList(scopes=scopes, **metadata.public_fields())

    def breakdown_page(
        self, connection, dimension: str, limit: int, offset: int,
    ) -> DatabaseCountPage:
        index_id = self._breakdown_index_id(connection, dimension)
        rows = self._breakdown_rows(connection, index_id, dimension, limit, offset)
        total = rows[0][2] if rows else 0
        items = [DatabaseCount(label=row[0], count=row[1]) for row in rows]
        metadata = self._breakdown_metadata(connection, dimension, index_id)
        next_offset = offset + len(items)
        return DatabaseCountPage(
            items=items, total=total, limit=limit, offset=offset,
            has_more=next_offset < total,
            next_offset=next_offset if next_offset < total else None,
            **metadata.public_fields(),
        )

    def breakdowns(self, connection, dimension: str) -> list[DatabaseCount]:
        index_id = self._breakdown_index_id(connection, dimension)
        rows = self._all_breakdown_rows(connection, index_id, dimension)
        return [DatabaseCount(label=row[0], count=row[1]) for row in rows]

    def _breakdown_metadata(self, connection, dimension, index_id):
        if dimension in ARCHIVE_BREAKDOWN_DIMENSIONS:
            _, metadata = self.archive_summary(connection)
            return metadata
        _, metadata = self.index_summary(connection, index_id)
        return metadata

    def _breakdown_index_id(self, connection, dimension) -> Optional[str]:
        if dimension in ARCHIVE_BREAKDOWN_DIMENSIONS:
            return None
        return self.active_index_id(connection)

    @staticmethod
    def active_index_id(connection) -> Optional[str]:
        row = connection.execute("""SELECT active_embedding_index_id
            FROM rag_application_settings WHERE id=1""").fetchone()
        return row[0] if row else None

    @staticmethod
    def _metadata(connection, key: str, exists: bool) -> ReadModelMetadata:
        row = connection.execute("""SELECT requested_revision,published_revision,
            status,generated_at,last_error FROM read_model_refresh_state
            WHERE projection_key=%s""", (key,)).fetchone()
        return metadata_from_state(row, exists)

    @classmethod
    def _archive_values(cls, connection) -> tuple[dict, bool]:
        row = connection.execute("""SELECT raw_message_count,unique_content_count,
            total_authors,total_conversations,oldest_message_at,newest_message_at
            FROM workspace_read_summary WHERE id=1""").fetchone()
        values = cls._empty_archive() if not row else {
            "raw_message_count": row[0], "unique_content_count": row[1],
            "total_authors": row[2], "total_channels": row[3],
            "oldest_message_at": row[4], "newest_message_at": row[5],
        }
        return values, bool(row)

    @classmethod
    def _index_values(cls, connection, index_id: str) -> tuple[dict, bool]:
        row = connection.execute("""SELECT chunk_count,indexed_message_count,
            pending_message_count FROM embedding_index_read_summary
            WHERE embedding_index_id=%s""", (index_id,)).fetchone()
        values = cls._empty_index() if not row else {
            "total_chunks": row[0], "indexed_message_count": row[1],
            "pending_message_count": row[2],
        }
        return values, bool(row)

    @staticmethod
    def _breakdown_rows(connection, index_id, dimension, limit, offset):
        if dimension in ARCHIVE_BREAKDOWN_DIMENSIONS:
            return connection.execute("""SELECT label,item_count,COUNT(*) OVER()
                FROM archive_breakdown_read_model WHERE dimension=%s
                ORDER BY item_count DESC,label,row_key LIMIT %s OFFSET %s""",
                (dimension, limit, offset),
            ).fetchall()
        if not index_id:
            return []
        return connection.execute("""SELECT label,item_count,
            COUNT(*) OVER() FROM database_breakdown_read_model
            WHERE embedding_index_id=%s AND dimension=%s
            ORDER BY item_count DESC,label LIMIT %s OFFSET %s""",
            (index_id, dimension, limit, offset),
        ).fetchall()

    @staticmethod
    def _all_breakdown_rows(connection, index_id, dimension):
        if dimension in ARCHIVE_BREAKDOWN_DIMENSIONS:
            return connection.execute("""SELECT label,item_count
                FROM archive_breakdown_read_model WHERE dimension=%s
                ORDER BY item_count DESC,label,row_key""", (dimension,)).fetchall()
        if not index_id:
            return []
        return connection.execute("""SELECT label,item_count
            FROM database_breakdown_read_model
            WHERE embedding_index_id=%s AND dimension=%s
            ORDER BY item_count DESC,label""", (index_id, dimension)).fetchall()

    @staticmethod
    def _empty_archive() -> dict:
        return {
            "raw_message_count": 0, "unique_content_count": 0,
            "total_authors": 0, "total_channels": 0,
            "oldest_message_at": None, "newest_message_at": None,
        }

    @staticmethod
    def _empty_index() -> dict:
        return {
            "total_chunks": 0, "indexed_message_count": 0,
            "pending_message_count": 0,
        }
