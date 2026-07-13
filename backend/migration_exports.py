import logging
import time
import uuid
from typing import Callable, List, Optional

from fastapi import FastAPI, Header, HTTPException, Query
from pydantic import BaseModel, Field

from backend.models import SourceMessageInput

LOGGER = logging.getLogger("uvicorn.error")


class MigrationExportView(BaseModel):
    export_id: str
    total_messages: int = 0


class MigrationExportPage(MigrationExportView):
    messages: List[SourceMessageInput] = Field(default_factory=list)
    next_cursor: Optional[str] = None
    done: bool = False


class MigrationExportService:
    def __init__(self, ensure_schema: Callable, connect: Callable) -> None:
        self.ensure_schema = ensure_schema
        self.connect = connect

    def create_snapshot(self) -> MigrationExportView:
        self.ensure_schema()
        export_id = str(uuid.uuid4())
        with self.connect() as connection:
            connection.execute(
                """INSERT INTO ingestion_sessions
                   (id,source_type,conversation_id,conversation_label,status,finished_at)
                   VALUES (%s,'migration-export',%s,'Desktop archive snapshot',
                           'completed',NOW())""",
                (export_id, export_id),
            )
            connection.execute(
                """INSERT INTO ingestion_session_messages(session_id,message_id)
                   SELECT %s,external_id FROM source_messages""", (export_id,),
            )
            total = connection.execute(
                """UPDATE ingestion_sessions SET raw_message_count=(
                     SELECT COUNT(*) FROM ingestion_session_messages WHERE session_id=%s)
                   WHERE id=%s RETURNING raw_message_count""",
                (export_id, export_id),
            ).fetchone()[0]
        return MigrationExportView(export_id=export_id, total_messages=total)

    def get_page(
        self, export_id: str, after_external_id: Optional[str], limit: int,
    ) -> MigrationExportPage:
        started = time.perf_counter()
        LOGGER.info(
            "migration_export_page_start export_id=%s cursor=%s limit=%s",
            export_id, after_external_id or "<start>", limit,
        )
        try:
            page = self._load_page(export_id, after_external_id, limit)
        except Exception:
            LOGGER.exception(
                "migration_export_page_failed export_id=%s cursor=%s duration_ms=%.1f",
                export_id, after_external_id or "<start>", elapsed_ms(started),
            )
            raise
        LOGGER.info(
            "migration_export_page_end export_id=%s cursor=%s next_cursor=%s "
            "batch_length=%s done=%s duration_ms=%.1f",
            export_id, after_external_id or "<start>", page.next_cursor or "<none>",
            len(page.messages), page.done, elapsed_ms(started),
        )
        return page

    def _load_page(
        self, export_id: str, after_external_id: Optional[str], limit: int,
    ) -> MigrationExportPage:
        self.ensure_schema()
        with self.connect() as connection:
            total = self._export_total(connection, export_id)
            rows = connection.execute(
                self._page_sql(), (export_id, after_external_id or "", limit + 1),
            ).fetchall()
        page_rows = rows[:limit]
        messages = [self._to_message(row) for row in page_rows]
        next_cursor = messages[-1].external_id if messages else after_external_id
        return MigrationExportPage(
            export_id=export_id, total_messages=total, messages=messages,
            next_cursor=next_cursor, done=len(rows) <= limit,
        )

    def get_snapshot(self, export_id: str) -> MigrationExportView:
        self.ensure_schema()
        with self.connect() as connection:
            total = self._export_total(connection, export_id)
        return MigrationExportView(export_id=export_id, total_messages=total)

    def delete_snapshot(self, export_id: str) -> None:
        self.ensure_schema()
        with self.connect() as connection:
            self._export_total(connection, export_id)
            connection.execute("DELETE FROM ingestion_sessions WHERE id=%s", (export_id,))

    @staticmethod
    def _export_total(connection, export_id: str) -> int:
        row = connection.execute(
            """SELECT raw_message_count FROM ingestion_sessions
               WHERE id=%s AND source_type='migration-export'""", (export_id,),
        ).fetchone()
        if not row:
            raise ValueError("Migration export snapshot was not found.")
        return row[0]

    @staticmethod
    def _page_sql() -> str:
        return """SELECT message.external_id,message.author,content.content,
                         message.sent_at,message.channel,message.channel_id,
                         message.guild_id,message.source_type,message.conversation_id,
                         message.conversation_label,message.container_id,
                         message.container_label,message.source_metadata,
                         message.message_order
                  FROM ingestion_session_messages snapshot
                  JOIN source_messages message ON message.external_id=snapshot.message_id
                  JOIN message_contents content ON content.content_hash=message.content_hash
                  WHERE snapshot.session_id=%s AND message.external_id>%s
                  ORDER BY message.external_id LIMIT %s"""

    @staticmethod
    def _to_message(row) -> SourceMessageInput:
        return SourceMessageInput(
            external_id=row[0], author=row[1], content=row[2], timestamp=row[3],
            channel=row[4], channel_id=row[5], guild_id=row[6], source_type=row[7],
            conversation_id=row[8], conversation_label=row[9], container_id=row[10],
            container_label=row[11], source_metadata=row[12], message_order=int(row[13]),
        )


def register_migration_export_routes(
    application: FastAPI, service: MigrationExportService, internal_token: Optional[str],
) -> None:
    def authorize(token: str) -> None:
        if internal_token and token != internal_token:
            raise HTTPException(status_code=403, detail="Migration export authorization failed.")

    @application.post("/internal/migration-exports", response_model=MigrationExportView)
    def create_export(x_chat_context_token: str = Header(default="")) -> MigrationExportView:
        authorize(x_chat_context_token)
        return service.create_snapshot()

    @application.get(
        "/internal/migration-exports/{export_id}/messages",
        response_model=MigrationExportPage,
    )
    def export_messages(
        export_id: str,
        after_external_id: Optional[str] = Query(default=None, max_length=128),
        limit: int = Query(default=400, ge=1, le=400),
        x_chat_context_token: str = Header(default=""),
    ) -> MigrationExportPage:
        authorize(x_chat_context_token)
        return service.get_page(export_id, after_external_id, limit)

    @application.get(
        "/internal/migration-exports/{export_id}", response_model=MigrationExportView,
    )
    def get_export(
        export_id: str, x_chat_context_token: str = Header(default=""),
    ) -> MigrationExportView:
        authorize(x_chat_context_token)
        return service.get_snapshot(export_id)

    @application.delete("/internal/migration-exports/{export_id}")
    def delete_export(
        export_id: str, x_chat_context_token: str = Header(default=""),
    ) -> dict:
        authorize(x_chat_context_token)
        service.delete_snapshot(export_id)
        return {"deleted": True}


def elapsed_ms(started: float) -> float:
    return (time.perf_counter() - started) * 1000
