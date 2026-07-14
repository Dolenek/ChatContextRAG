from typing import Callable, List, Optional

import psycopg

from backend.chat_models import ChatScope
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import NormalizedMessage


class PostgresMessageContextReader:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def load(
        self, anchor_message_id: str, before_count: int, after_count: int,
        scope: Optional[ChatScope],
    ) -> List[NormalizedMessage]:
        self._validate_counts(before_count, after_count)
        self.ensure_schema()
        try:
            with self.connect() as connection:
                connection.execute("SET LOCAL statement_timeout = '10s'")
                rows = connection.execute(
                    self._query(), self._parameters(
                        anchor_message_id, before_count, after_count, scope,
                    ),
                ).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL context read failed.") from error
        return [NormalizedMessage(*row) for row in rows]

    @staticmethod
    def _validate_counts(before_count: int, after_count: int) -> None:
        if not 0 <= before_count <= 10 or not 0 <= after_count <= 10:
            raise ValueError("Context counts must be between 0 and 10.")
        if before_count + after_count < 1:
            raise ValueError("At least one context message must be requested.")

    @staticmethod
    def _parameters(anchor_id, before_count, after_count, scope):
        source_type = scope.source_type if scope else None
        conversation_id = scope.conversation_id if scope else None
        return (
            anchor_id, source_type, source_type, conversation_id, conversation_id,
            before_count, after_count,
        )

    @staticmethod
    def _query() -> str:
        columns = """m.external_id,m.author,c.content,m.sent_at,m.channel,
                     m.channel_id,m.guild_id,m.source_type,m.conversation_id,
                     m.conversation_label,m.container_id,m.container_label,
                     m.source_metadata,m.message_order"""
        return f"""WITH anchor AS (
                  SELECT external_id,source_type,conversation_id,message_order
                  FROM source_messages WHERE external_id=%s
                    AND (%s::text IS NULL OR source_type=%s)
                    AND (%s::text IS NULL OR conversation_id=%s)),
                nearby_ids AS (
                  (SELECT m.external_id,m.message_order FROM source_messages m,anchor a
                   WHERE m.source_type=a.source_type AND m.conversation_id=a.conversation_id
                     AND m.message_order<a.message_order
                   ORDER BY m.message_order DESC,m.external_id DESC LIMIT %s)
                  UNION ALL
                  (SELECT m.external_id,m.message_order FROM source_messages m,anchor a
                   WHERE m.external_id=a.external_id)
                  UNION ALL
                  (SELECT m.external_id,m.message_order FROM source_messages m,anchor a
                   WHERE m.source_type=a.source_type AND m.conversation_id=a.conversation_id
                     AND m.message_order>a.message_order
                   ORDER BY m.message_order,m.external_id LIMIT %s))
                SELECT {columns} FROM nearby_ids nearby
                JOIN source_messages m ON m.external_id=nearby.external_id
                JOIN message_contents c ON c.content_hash=m.content_hash
                ORDER BY nearby.message_order,m.external_id"""
