from typing import Dict, List, Protocol, Tuple

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
                table_names = self._existing_chunk_tables(connection)
                rows = [
                    row
                    for table_name in table_names
                    for row in connection.execute(self._scope_sql(table_name)).fetchall()
                ]
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL chat scope query failed.") from error
        return self._merge_rows(rows)

    @staticmethod
    def _existing_chunk_tables(connection) -> List[str]:
        candidates = ("rag_chunks", "conversation_chunks")
        return [
            table_name for table_name in candidates
            if connection.execute("SELECT to_regclass(%s)", (table_name,)).fetchone()[0]
        ]

    @staticmethod
    def _scope_sql(table_name: str) -> str:
        return f"""SELECT
            COALESCE(metadata->>'source_type', 'discord') AS source_type,
            COALESCE(metadata->>'conversation_id', metadata->>'channel_id') conversation_id,
            COALESCE(MAX(channel), 'Unnamed conversation') display_name,
            COALESCE(MAX(metadata->>'container_label'),
                     MAX(metadata->>'guild_id')) container_name,
            COUNT(DISTINCT source_message_id) message_count
        FROM {table_name}, LATERAL UNNEST(source_message_ids) source_message_id
        WHERE COALESCE(metadata->>'conversation_id', metadata->>'channel_id') IS NOT NULL
        GROUP BY source_type, conversation_id"""

    @staticmethod
    def _merge_rows(rows: list) -> List[ChatScopeOption]:
        merged: Dict[Tuple[str, str], ChatScopeOption] = {}
        for source_type, conversation_id, display_name, container_name, count in rows:
            key = (source_type, conversation_id)
            previous = merged.get(key)
            merged[key] = ChatScopeOption(
                source_type=source_type,
                conversation_id=conversation_id,
                display_name=display_name if not previous else previous.display_name,
                container_name=container_name or (previous.container_name if previous else None),
                message_count=max(int(count), previous.message_count if previous else 0),
            )
        return sorted(
            merged.values(),
            key=lambda scope: (scope.source_type, scope.display_name.casefold()),
        )
