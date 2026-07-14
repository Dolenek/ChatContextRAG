from typing import Callable

import psycopg

from backend.archive_time import validated_zone
from backend.models import WorkspaceSettingsUpdate, WorkspaceSettingsView
from backend.openai_gateway import ExternalIntegrationError


class PostgresWorkspaceSettingsRepository:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def get(self) -> WorkspaceSettingsView:
        self.ensure_schema()
        try:
            with self.connect() as connection:
                connection.execute("SET LOCAL statement_timeout='10s'")
                row = connection.execute(
                    "SELECT timezone_name FROM rag_application_settings WHERE id=1",
                ).fetchone()
        except psycopg.Error as error:
            raise ExternalIntegrationError("Workspace settings read failed.") from error
        return WorkspaceSettingsView(timezone_name=row[0] if row else "UTC")

    def update(self, update: WorkspaceSettingsUpdate) -> WorkspaceSettingsView:
        validated_zone(update.timezone_name)
        self.ensure_schema()
        try:
            with self.connect() as connection:
                connection.execute("SET LOCAL statement_timeout='10s'")
                row = connection.execute(
                    """UPDATE rag_application_settings SET timezone_name=%s WHERE id=1
                       RETURNING timezone_name""", (update.timezone_name,),
                ).fetchone()
        except psycopg.Error as error:
            raise ExternalIntegrationError("Workspace settings update failed.") from error
        if not row:
            raise ValueError("Workspace settings are not initialized.")
        return WorkspaceSettingsView(timezone_name=row[0])
