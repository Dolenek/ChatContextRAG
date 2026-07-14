from typing import List, Protocol

import psycopg

from backend.models import ChatScopeOption
from backend.openai_gateway import ExternalIntegrationError


class ChatScopeCatalog(Protocol):
    def list_scopes(self) -> List[ChatScopeOption]:
        ...


class PostgresChatScopeCatalog:
    """Lists searchable conversations using source-neutral RAG metadata."""

    def __init__(self, database_dsn: str) -> None:
        self.database_dsn = database_dsn

    def list_scopes(self) -> List[ChatScopeOption]:
        try:
            with psycopg.connect(self.database_dsn) as connection:
                rows = connection.execute(self._scope_sql()).fetchall()
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL chat scope query failed.") from error
        return sorted(
            [self._to_scope(row) for row in rows],
            key=lambda scope: (scope.source_type, scope.display_name.casefold()),
        )

    @staticmethod
    def _scope_sql() -> str:
        return """SELECT message.source_type,message.conversation_id,
            COALESCE(MAX(message.conversation_label),MAX(message.channel),
                     'Unnamed conversation') display_name,
            COALESCE(MAX(message.container_label),MAX(message.guild_id)) container_name,
            COUNT(DISTINCT message.external_id) message_count
        FROM rag_chunk_messages link
        JOIN rag_application_settings settings ON settings.id=1
          AND settings.active_embedding_index_id=link.embedding_index_id
        JOIN source_messages message ON message.external_id=link.message_id
        WHERE message.conversation_id IS NOT NULL
        GROUP BY message.source_type,message.conversation_id"""

    @staticmethod
    def _to_scope(row: tuple) -> ChatScopeOption:
        return ChatScopeOption(
            source_type=row[0], conversation_id=row[1], display_name=row[2],
            container_name=row[3], message_count=int(row[4]),
        )
