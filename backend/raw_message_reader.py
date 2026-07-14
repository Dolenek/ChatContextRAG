from typing import Callable, Iterator, List, Optional, Sequence

import psycopg

from backend.models import SourceConversationView
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import NormalizedMessage


class PostgresRawMessageReader:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def load_by_ids(self, message_ids: Sequence[str]) -> List[NormalizedMessage]:
        ordered_ids = list(dict.fromkeys(message_ids))
        if not ordered_ids:
            return []
        self.ensure_schema()
        try:
            with self.connect() as connection:
                rows = connection.execute(self._messages_by_id_query(), (ordered_ids,)).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL source message read failed.") from error
        messages = {row[0]: NormalizedMessage(*row) for row in rows}
        return [messages[item] for item in ordered_ids if item in messages]

    def iter_session(
        self, session_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        self.ensure_schema()
        with self.connect() as connection, connection.cursor(
            name=f"session_{session_id.replace('-', '')[:20]}",
        ) as cursor:
            cursor.itersize = page_size
            cursor.execute(self._session_messages_query(), (session_id,))
            for row in cursor:
                yield NormalizedMessage(*row)

    def iter_job(
        self, job_id: str, page_size: int = 5000,
    ) -> Iterator[NormalizedMessage]:
        self.ensure_schema()
        with self.connect() as connection:
            connection.execute("SET LOCAL work_mem='16MB'")
            with connection.cursor(name=f"job_{job_id.replace('-', '')[:20]}") as cursor:
                cursor.itersize = page_size
                cursor.execute(self._job_messages_query(), (job_id,))
                for row in cursor:
                    yield NormalizedMessage(*row)

    def find_oldest_discord_id(
        self, channel_id: str, channel_name: Optional[str],
    ) -> Optional[str]:
        self.ensure_schema()
        with self.connect() as connection:
            row = connection.execute(
                """SELECT external_id FROM source_messages
                   WHERE source_type='discord' AND
                     (channel_id=%s OR (channel_id IS NULL AND channel=%s))
                   ORDER BY message_order, external_id LIMIT 1""",
                (channel_id, channel_name),
            ).fetchone()
        return row[0] if row else None

    def list_conversations(self, source_type: str) -> List[SourceConversationView]:
        self.ensure_schema()
        with self.connect() as connection:
            rows = connection.execute(
                """SELECT source_type,conversation_id,
                          COALESCE(MAX(conversation_label),MAX(channel),'Unnamed conversation'),
                          COALESCE(MAX(container_label),MAX(container_id)),COUNT(*)
                   FROM source_messages WHERE source_type=%s
                     AND conversation_id IS NOT NULL
                   GROUP BY source_type,conversation_id ORDER BY 3""", (source_type,),
            ).fetchall()
        return [SourceConversationView(
            source_type=row[0], conversation_id=row[1], display_name=row[2],
            container_name=row[3], message_count=row[4],
        ) for row in rows]

    @staticmethod
    def _messages_by_id_query() -> str:
        return f"""SELECT {PostgresRawMessageReader._columns()}
                   FROM source_messages m
                   JOIN message_contents c ON c.content_hash=m.content_hash
                   WHERE m.external_id=ANY(%s)"""

    @staticmethod
    def _session_messages_query() -> str:
        return f"""WITH session_ids AS (
                     SELECT message_id FROM ingestion_session_messages WHERE session_id=%s),
                   affected_chunks AS (
                     SELECT DISTINCT chunk_id FROM rag_chunk_messages
                     WHERE message_id IN (SELECT message_id FROM session_ids)),
                   target_ids AS (
                     SELECT message_id FROM session_ids UNION
                     SELECT message_id FROM rag_chunk_messages
                     WHERE chunk_id IN (SELECT chunk_id FROM affected_chunks))
                   SELECT {PostgresRawMessageReader._columns()}
                   FROM target_ids target
                   JOIN source_messages m ON m.external_id=target.message_id
                   JOIN message_contents c ON c.content_hash=m.content_hash
                   ORDER BY m.message_order,m.external_id"""

    @staticmethod
    def _job_messages_query() -> str:
        return f"""SELECT {PostgresRawMessageReader._columns()}
                   FROM indexing_job_messages jm
                   JOIN source_messages m ON m.external_id=jm.message_id
                   JOIN message_contents c ON c.content_hash=m.content_hash
                   WHERE jm.job_id=%s ORDER BY m.message_order,m.external_id"""

    @staticmethod
    def _columns() -> str:
        return """m.external_id,m.author,c.content,m.sent_at,m.channel,
                  m.channel_id,m.guild_id,m.source_type,m.conversation_id,
                  m.conversation_label,m.container_id,m.container_label,
                  m.source_metadata,m.message_order"""
