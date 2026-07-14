from typing import Callable, List

from backend.models import IntegrationSyncState


class PostgresIntegrationSyncRepository:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def list(self, source_type: str) -> List[IntegrationSyncState]:
        self.ensure_schema()
        with self.connect() as connection:
            rows = connection.execute(self._list_query(), (
                source_type, source_type, source_type,
            )).fetchall()
        return [self._state_from_row(row) for row in rows]

    def upsert(self, state: IntegrationSyncState) -> IntegrationSyncState:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(self._upsert_query(), (
                state.source_type, state.conversation_id, state.container_id,
                state.conversation_label, state.container_label, state.oldest_cursor,
                state.newest_cursor, state.backfill_complete,
                state.active_session_id, state.tracking_enabled, state.last_error,
            )).fetchone()
        return self._state_from_row(
            row, state.raw_message_count, state.indexed_message_count,
        )

    @staticmethod
    def _state_from_row(row, raw_count=None, indexed_count=None):
        return IntegrationSyncState(
            source_type=row[0], conversation_id=row[1], container_id=row[2],
            conversation_label=row[3], container_label=row[4], oldest_cursor=row[5],
            newest_cursor=row[6], active_session_id=row[7], backfill_complete=row[8],
            tracking_enabled=row[9], last_error=row[10],
            raw_message_count=row[11] if raw_count is None else raw_count,
            indexed_message_count=row[12] if indexed_count is None else indexed_count,
        )

    @staticmethod
    def _list_query() -> str:
        return """WITH raw_counts AS (
                     SELECT source_type,conversation_id,COUNT(*) AS message_count
                     FROM source_messages WHERE source_type=%s
                     GROUP BY source_type,conversation_id),
                   indexed_counts AS (
                     SELECT message.source_type,message.conversation_id,
                            COUNT(DISTINCT link.message_id) AS message_count
                     FROM rag_chunk_messages link
                     JOIN rag_application_settings settings ON settings.id=1
                       AND settings.active_embedding_index_id=link.embedding_index_id
                     JOIN source_messages message ON message.external_id=link.message_id
                     WHERE message.source_type=%s
                     GROUP BY message.source_type,message.conversation_id)
                   SELECT state.source_type,state.conversation_id,state.container_id,
                          state.conversation_label,container_label,oldest_cursor,newest_cursor,
                          active_session_id,backfill_complete,tracking_enabled,last_error,
                          COALESCE(raw_counts.message_count,0),
                          COALESCE(indexed_counts.message_count,0)
                   FROM integration_sync_states state
                   LEFT JOIN raw_counts USING(source_type,conversation_id)
                   LEFT JOIN indexed_counts USING(source_type,conversation_id)
                   WHERE state.source_type=%s ORDER BY conversation_label"""

    @staticmethod
    def _upsert_query() -> str:
        return """INSERT INTO integration_sync_states
                   (source_type,conversation_id,container_id,conversation_label,
                    container_label,oldest_cursor,newest_cursor,backfill_complete,
                    active_session_id,tracking_enabled,last_error,updated_at)
                   VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,NOW())
                   ON CONFLICT(source_type,conversation_id) DO UPDATE SET
                     container_id=EXCLUDED.container_id,
                     conversation_label=EXCLUDED.conversation_label,
                     container_label=EXCLUDED.container_label,
                     oldest_cursor=EXCLUDED.oldest_cursor,
                     newest_cursor=EXCLUDED.newest_cursor,
                     backfill_complete=EXCLUDED.backfill_complete,
                     active_session_id=EXCLUDED.active_session_id,
                     tracking_enabled=EXCLUDED.tracking_enabled,
                     last_error=EXCLUDED.last_error,updated_at=NOW()
                   RETURNING source_type,conversation_id,container_id,conversation_label,
                     container_label,oldest_cursor,newest_cursor,active_session_id,
                     backfill_complete,tracking_enabled,last_error"""
