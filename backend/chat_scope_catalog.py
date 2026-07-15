from typing import Protocol

import psycopg

from backend.chat_models import ChatScopeList
from backend.openai_gateway import ExternalIntegrationError
from backend.read_models.reader import PostgresReadModelReader


class ChatScopeCatalog(Protocol):
    def list_scopes(self) -> ChatScopeList:
        ...


class PostgresChatScopeCatalog:
    """Lists searchable conversations using source-neutral RAG metadata."""

    def __init__(
        self, database_dsn: str,
        read_model_reader: PostgresReadModelReader | None = None,
    ) -> None:
        self.database_dsn = database_dsn
        self.read_model_reader = read_model_reader or PostgresReadModelReader(database_dsn)

    def list_scopes(self) -> ChatScopeList:
        try:
            with psycopg.connect(self.database_dsn) as connection:
                return self.read_model_reader.scopes(connection)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL chat scope query failed.") from error
