from typing import Callable, Dict, Sequence

import psycopg

from backend.models import ChatSourceChunk
from backend.openai_gateway import ExternalIntegrationError


class PostgresActiveChunkContextReader:
    """Bulk-loads the current active-index chunk for historical messages."""

    def __init__(self, ensure_schema: Callable, connection_factory: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connection_factory = connection_factory

    def load(self, message_ids: Sequence[str]) -> Dict[str, ChatSourceChunk]:
        ordered_ids = list(dict.fromkeys(message_ids))
        if not ordered_ids:
            return {}
        self.ensure_schema()
        try:
            with self.connection_factory() as connection:
                rows = connection.execute(self._query(), (ordered_ids,)).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL chunk context read failed.") from error
        return {row[0]: self._chunk(row) for row in rows}

    @staticmethod
    def _chunk(row: tuple) -> ChatSourceChunk:
        return ChatSourceChunk(
            chunk_id=row[1], content=row[2], source_message_ids=row[3],
            origin="reconstructed",
        )

    @staticmethod
    def _query() -> str:
        return """SELECT DISTINCT ON (link.message_id)
                         link.message_id,chunk.id,chunk.content,chunk.source_message_ids
                  FROM rag_chunk_messages link
                  JOIN rag_application_settings settings ON settings.id=1
                    AND settings.active_embedding_index_id=link.embedding_index_id
                  JOIN rag_chunks chunk
                    ON chunk.embedding_index_id=link.embedding_index_id
                   AND chunk.id=link.chunk_id
                  WHERE link.message_id=ANY(%s)
                  ORDER BY link.message_id,link.position,chunk.updated_at DESC,chunk.id"""
