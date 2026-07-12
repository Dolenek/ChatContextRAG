import hashlib
from typing import Iterable, List, Sequence

from psycopg.types.json import Jsonb

from backend.vector_models import NormalizedMessage


class RawMessageWriter:
    def store_messages(
        self, connection, session_id: str, messages: Sequence[NormalizedMessage],
    ) -> tuple:
        unique_messages = self.deduplicate_messages(messages)
        self._assert_running_session(connection, session_id)
        self._lock_message_ids(connection, unique_messages)
        existing_ids = self._existing_ids(connection, unique_messages)
        existing_hashes = self._existing_hashes(connection, unique_messages)
        replaced_hashes = self._current_hashes(connection, unique_messages)
        new_hashes = self._upsert_contents(connection, unique_messages)
        self._upsert_messages(connection, unique_messages)
        self._link_session_messages(connection, session_id, unique_messages)
        affected_hashes = new_hashes | replaced_hashes
        self._refresh_occurrence_counts(connection, affected_hashes)
        self._delete_unreferenced_contents(connection, affected_hashes)
        self._refresh_session_count(connection, session_id)
        return len(unique_messages) - len(existing_ids), len(new_hashes - existing_hashes)

    def _upsert_contents(self, connection, messages) -> set:
        content_rows = {(self.content_hash(message.content), message.content) for message in messages}
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO message_contents(content_hash,content) VALUES (%s,%s)
                   ON CONFLICT(content_hash) DO NOTHING""", list(content_rows),
            )
        return {row[0] for row in content_rows}

    def _upsert_messages(self, connection, messages) -> None:
        rows = [(
            message.external_id, message.message_order or self.message_order(message.external_id),
            message.author,
            message.timestamp, message.channel, message.channel_id, message.guild_id,
            message.source_type, message.conversation_id or message.channel_id,
            message.conversation_label or message.channel,
            message.container_id or message.guild_id, message.container_label,
            Jsonb(message.source_metadata),
            self.content_hash(message.content),
        ) for message in messages]
        with connection.cursor() as cursor:
            cursor.executemany(self._message_upsert_sql(), rows)

    @staticmethod
    def _message_upsert_sql() -> str:
        return """INSERT INTO source_messages
          (external_id,message_order,author,sent_at,channel,channel_id,guild_id,
           source_type,conversation_id,conversation_label,container_id,
           container_label,source_metadata,content_hash)
          VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
          ON CONFLICT(external_id) DO UPDATE SET author=EXCLUDED.author,
            sent_at=EXCLUDED.sent_at,channel=EXCLUDED.channel,
            channel_id=EXCLUDED.channel_id,guild_id=EXCLUDED.guild_id,
            source_type=EXCLUDED.source_type,conversation_id=EXCLUDED.conversation_id,
            conversation_label=EXCLUDED.conversation_label,
            container_id=EXCLUDED.container_id,container_label=EXCLUDED.container_label,
            source_metadata=EXCLUDED.source_metadata,content_hash=EXCLUDED.content_hash,
            updated_at=NOW()
          WHERE (source_messages.author,source_messages.sent_at,source_messages.channel,
            source_messages.channel_id,source_messages.guild_id,source_messages.source_type,
            source_messages.conversation_id,source_messages.conversation_label,
            source_messages.container_id,source_messages.container_label,
            source_messages.source_metadata,source_messages.content_hash)
          IS DISTINCT FROM
            (EXCLUDED.author,EXCLUDED.sent_at,EXCLUDED.channel,EXCLUDED.channel_id,
             EXCLUDED.guild_id,EXCLUDED.source_type,EXCLUDED.conversation_id,
             EXCLUDED.conversation_label,EXCLUDED.container_id,
             EXCLUDED.container_label,EXCLUDED.source_metadata,EXCLUDED.content_hash)"""

    @staticmethod
    def _link_session_messages(connection, session_id, messages) -> None:
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO ingestion_session_messages(session_id,message_id)
                   VALUES (%s,%s) ON CONFLICT DO NOTHING""",
                [(session_id, message.external_id) for message in messages],
            )

    @staticmethod
    def _refresh_occurrence_counts(connection, hashes: Iterable[str]) -> None:
        connection.execute(
            """UPDATE message_contents c SET occurrence_count=(
                 SELECT COUNT(*) FROM source_messages m WHERE m.content_hash=c.content_hash)
               WHERE c.content_hash=ANY(%s)""", (list(hashes),),
        )

    @staticmethod
    def _delete_unreferenced_contents(connection, hashes: Iterable[str]) -> None:
        connection.execute(
            """DELETE FROM message_contents c WHERE c.content_hash=ANY(%s)
               AND NOT EXISTS (SELECT 1 FROM source_messages m
                               WHERE m.content_hash=c.content_hash)""",
            (list(hashes),),
        )

    @staticmethod
    def _refresh_session_count(connection, session_id: str) -> None:
        connection.execute(
            """UPDATE ingestion_sessions SET raw_message_count=(
                 SELECT COUNT(*) FROM ingestion_session_messages WHERE session_id=%s)
               WHERE id=%s""", (session_id, session_id),
        )

    @staticmethod
    def _existing_ids(connection, messages) -> set:
        message_ids = [message.external_id for message in messages]
        rows = connection.execute(
            "SELECT external_id FROM source_messages WHERE external_id=ANY(%s)",
            (message_ids,),
        ).fetchall()
        return {row[0] for row in rows}

    def _existing_hashes(self, connection, messages) -> set:
        content_hashes = [self.content_hash(message.content) for message in messages]
        rows = connection.execute(
            "SELECT content_hash FROM message_contents WHERE content_hash=ANY(%s)",
            (content_hashes,),
        ).fetchall()
        return {row[0] for row in rows}

    @staticmethod
    def _lock_message_ids(connection, messages) -> None:
        message_ids = [message.external_id for message in messages]
        connection.execute(
            """SELECT pg_advisory_xact_lock(hashtextextended(message_id, 0))
               FROM (SELECT DISTINCT unnest(%s::text[]) AS message_id
                     ORDER BY message_id) locked_messages""",
            (message_ids,),
        )

    @staticmethod
    def _current_hashes(connection, messages) -> set:
        message_ids = [message.external_id for message in messages]
        rows = connection.execute(
            "SELECT content_hash FROM source_messages WHERE external_id=ANY(%s)",
            (message_ids,),
        ).fetchall()
        return {row[0] for row in rows}

    @staticmethod
    def _assert_running_session(connection, session_id: str) -> None:
        row = connection.execute(
            "SELECT status FROM ingestion_sessions WHERE id=%s FOR UPDATE", (session_id,)
        ).fetchone()
        if not row or row[0] != "running":
            raise ValueError("Ingestion session is not running.")

    @staticmethod
    def deduplicate_messages(
        messages: Sequence[NormalizedMessage],
    ) -> List[NormalizedMessage]:
        latest_by_external_id = {}
        for message in messages:
            latest_by_external_id[message.external_id] = message
        return list(latest_by_external_id.values())

    @staticmethod
    def content_hash(content: str) -> str:
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    @staticmethod
    def message_order(external_id: str) -> int:
        return int(external_id) if external_id.isdigit() else 0
