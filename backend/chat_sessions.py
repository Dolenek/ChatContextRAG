import uuid
from typing import Callable, List, Optional, Protocol

import psycopg
from psycopg.types.json import Jsonb

from backend.models import (
    ChatRequest, ChatResponse, ChatScope, ChatSessionDetail, ChatSessionMessage,
    ChatSessionSummary, ChatSource,
)
from backend.openai_gateway import ExternalIntegrationError


class ChatSessionNotFoundError(LookupError):
    pass


class ChatSessionRepository(Protocol):
    def list_recent(self, limit: int) -> List[ChatSessionSummary]: ...

    def get(self, session_id: str) -> ChatSessionDetail: ...

    def save_turn(self, request: ChatRequest, response: ChatResponse) -> ChatSessionSummary: ...

    def rename(self, session_id: str, title: str) -> ChatSessionSummary: ...

    def delete(self, session_id: str) -> None: ...


class PostgresChatSessionRepository:
    def __init__(
        self, schema_initializer: Callable[[], None],
        connection_factory: Callable[[], object],
    ) -> None:
        self.schema_initializer = schema_initializer
        self.connection_factory = connection_factory

    def list_recent(self, limit: int) -> List[ChatSessionSummary]:
        self.schema_initializer()
        try:
            with self.connection_factory() as connection:
                rows = connection.execute(
                    """SELECT id,title,created_at,updated_at FROM chat_sessions
                       ORDER BY updated_at DESC,id LIMIT %s""", (limit,),
                ).fetchall()
        except psycopg.Error as error:
            self._raise_storage_error(error)
        return [self._summary(row) for row in rows]

    def get(self, session_id: str) -> ChatSessionDetail:
        self.schema_initializer()
        try:
            with self.connection_factory() as connection:
                session = connection.execute(
                    """SELECT id,title,source_type,conversation_id,chat_provider_id,
                       chat_model,reasoning_effort,retrieval_mode,
                       evidence_character_limit,created_at,updated_at
                       FROM chat_sessions WHERE id=%s""",
                    (session_id,),
                ).fetchone()
                if not session:
                    raise ChatSessionNotFoundError("Chat session was not found.")
                messages = connection.execute(
                    """SELECT role,content,sources,created_at FROM chat_session_messages
                       WHERE session_id=%s ORDER BY position""", (session_id,),
                ).fetchall()
        except psycopg.Error as error:
            self._raise_storage_error(error)
        return self._detail(session, messages)

    def save_turn(self, request: ChatRequest, response: ChatResponse) -> ChatSessionSummary:
        self.schema_initializer()
        try:
            with self.connection_factory() as connection:
                session_id = request.session_id or str(uuid.uuid4())
                row = self._lock_or_create(connection, session_id, request, response)
                next_position = connection.execute(
                    """SELECT COALESCE(MAX(position),-1)+1 FROM chat_session_messages
                       WHERE session_id=%s""", (session_id,),
                ).fetchone()[0]
                self._insert_messages(connection, session_id, next_position, request, response)
                row = connection.execute(
                    """UPDATE chat_sessions SET updated_at=NOW() WHERE id=%s
                       RETURNING id,title,created_at,updated_at""", (session_id,),
                ).fetchone()
        except psycopg.Error as error:
            self._raise_storage_error(error)
        return self._summary(row)

    def rename(self, session_id: str, title: str) -> ChatSessionSummary:
        self.schema_initializer()
        normalized_title = " ".join(title.split())
        if not normalized_title:
            raise ValueError("Chat title cannot be empty.")
        try:
            with self.connection_factory() as connection:
                row = connection.execute(
                    """UPDATE chat_sessions SET title=%s,title_manually_edited=TRUE,
                       updated_at=NOW() WHERE id=%s
                       RETURNING id,title,created_at,updated_at""",
                    (normalized_title, session_id),
                ).fetchone()
        except psycopg.Error as error:
            self._raise_storage_error(error)
        if not row:
            raise ChatSessionNotFoundError("Chat session was not found.")
        return self._summary(row)

    def delete(self, session_id: str) -> None:
        self.schema_initializer()
        try:
            with self.connection_factory() as connection:
                cursor = connection.execute(
                    "DELETE FROM chat_sessions WHERE id=%s", (session_id,),
                )
        except psycopg.Error as error:
            self._raise_storage_error(error)
        if cursor.rowcount == 0:
            raise ChatSessionNotFoundError("Chat session was not found.")

    def _lock_or_create(self, connection, session_id, request, response):
        row = connection.execute(
            """SELECT id,title,source_type,conversation_id,chat_provider_id,
               chat_model,reasoning_effort,retrieval_mode,evidence_character_limit,
               created_at,updated_at FROM chat_sessions
               WHERE id=%s FOR UPDATE""", (session_id,),
        ).fetchone()
        if row:
            self._validate_context(row, request, response)
            return row
        if request.session_id:
            raise ChatSessionNotFoundError("Chat session was not found.")
        scope = request.scope
        return connection.execute(
            """INSERT INTO chat_sessions
               (id,title,source_type,conversation_id,chat_provider_id,chat_model,
                reasoning_effort,retrieval_mode,evidence_character_limit)
               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
               RETURNING id,title,source_type,conversation_id,chat_provider_id,
                         chat_model,reasoning_effort,retrieval_mode,
                         evidence_character_limit,created_at,updated_at""",
            (
                session_id, self._automatic_title(request.question),
                scope.source_type if scope else None,
                scope.conversation_id if scope else None,
                response.chat_provider_id, response.chat_model,
                response.reasoning_effort, response.retrieval_mode,
                response.evidence_character_limit,
            ),
        ).fetchone()

    @staticmethod
    def _validate_context(row, request: ChatRequest, response: ChatResponse) -> None:
        scope = request.scope
        current_context = (
            scope.source_type if scope else None,
            scope.conversation_id if scope else None,
            response.chat_provider_id,
            response.chat_model,
            response.reasoning_effort,
            response.retrieval_mode,
            response.evidence_character_limit,
        )
        if tuple(row[2:9]) != current_context:
            raise ValueError(
                "Chat session context no longer matches its source, model, reasoning effort, "
                "or retrieval configuration."
            )

    @staticmethod
    def _insert_messages(connection, session_id, position, request, response) -> None:
        serialized_sources = [source.model_dump(mode="json") for source in response.sources]
        message_rows = [
            (session_id, position, "user", request.question, Jsonb([])),
            (session_id, position + 1, "assistant", response.answer, Jsonb(serialized_sources)),
        ]
        with connection.cursor() as cursor:
            cursor.executemany(
                """INSERT INTO chat_session_messages
                   (session_id,position,role,content,sources) VALUES (%s,%s,%s,%s,%s)""",
                message_rows,
            )

    @staticmethod
    def _automatic_title(question: str) -> str:
        normalized = " ".join(question.split())
        return normalized if len(normalized) <= 80 else normalized[:77].rstrip() + "..."

    @staticmethod
    def _summary(row) -> ChatSessionSummary:
        return ChatSessionSummary(
            session_id=row[0], title=row[1], created_at=row[-2], updated_at=row[-1],
        )

    @classmethod
    def _detail(cls, row, message_rows) -> ChatSessionDetail:
        scope = ChatScope(source_type=row[2], conversation_id=row[3]) if row[2] else None
        if len(row) == 9:
            retrieval_mode, evidence_limit, created_at, updated_at = (
                "deterministic", None, row[7], row[8],
            )
        else:
            retrieval_mode, evidence_limit, created_at, updated_at = row[7:11]
        messages = [
            ChatSessionMessage(
                role=message[0], content=message[1],
                sources=[ChatSource.model_validate(source) for source in message[2]],
                created_at=message[3],
            )
            for message in message_rows
        ]
        return ChatSessionDetail(
            session_id=row[0], title=row[1], scope=scope,
            chat_provider_id=row[4], chat_model=row[5],
            reasoning_effort=row[6], retrieval_mode=retrieval_mode,
            evidence_character_limit=evidence_limit,
            created_at=created_at, updated_at=updated_at,
            messages=messages,
        )

    @staticmethod
    def _raise_storage_error(error: psycopg.Error) -> None:
        raise ExternalIntegrationError("PostgreSQL chat session operation failed.") from error
