from datetime import datetime, timezone

import pytest

from backend.chat_sessions import (
    ChatSessionNotFoundError, PostgresChatSessionRepository,
)
from backend.models import ChatRequest, ChatResponse, ChatScope, ChatSource


def test_new_turn_is_created_with_two_ordered_messages_in_one_connection() -> None:
    connection = ScriptedConnection()
    repository = PostgresChatSessionRepository(lambda: None, lambda: connection)
    request = ChatRequest(
        question="  Kdy   bude opravdu velmi dlouhý plán vydání, který potřebujeme dokončit včas pro všechny?  ",
        scope=ChatScope(source_type="discord", conversation_id="general"),
        reasoning_effort="medium",
    )
    response = _response()

    summary = repository.save_turn(request, response)

    assert summary.session_id == connection.session_row[0]
    assert len(summary.title) <= 80
    assert "  " not in summary.title
    assert [row[2] for row in connection.message_rows] == ["user", "assistant"]
    assert [row[1] for row in connection.message_rows] == [0, 1]
    assert connection.context_entries == 1
    assert connection.cursor_batches == 1


def test_continuation_rejects_a_different_scope_or_model() -> None:
    connection = ScriptedConnection(existing=True)
    repository = PostgresChatSessionRepository(lambda: None, lambda: connection)
    request = ChatRequest(
        question="Pokračuj prosím", session_id="session-1",
        scope=ChatScope(source_type="discord", conversation_id="different"),
    )

    with pytest.raises(ValueError, match="context"):
        repository.save_turn(request, _response())

    assert connection.message_rows == []


def test_continuation_rejects_a_different_reasoning_effort() -> None:
    connection = ScriptedConnection(existing=True)
    repository = PostgresChatSessionRepository(lambda: None, lambda: connection)
    request = ChatRequest(
        question="Pokračuj prosím", session_id="session-1",
        scope=ChatScope(source_type="discord", conversation_id="general"),
        reasoning_effort="high",
    )

    with pytest.raises(ValueError, match="reasoning effort"):
        repository.save_turn(request, _response("high"))

    assert connection.message_rows == []


def test_continuation_with_unknown_id_returns_not_found() -> None:
    repository = PostgresChatSessionRepository(
        lambda: None, lambda: ScriptedConnection(),
    )
    request = ChatRequest(question="Pokračuj prosím", session_id="missing")

    with pytest.raises(ChatSessionNotFoundError):
        repository.save_turn(request, _response())


def _response(reasoning_effort="medium"):
    return ChatResponse(
        answer="V pátek.", chat_provider_id="openai", chat_model="chat-model",
        reasoning_effort=reasoning_effort,
        sources=[ChatSource(
            author="Ada", content="Termín je v pátek.", timestamp=None,
            channel="general", similarity_score=0.9,
        )],
    )


class ScriptedCursor:
    def __init__(self, row=None, rows=None, rowcount=1):
        self.row = row
        self.rows = rows or []
        self.rowcount = rowcount

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class ScriptedBatchCursor:
    def __init__(self, connection):
        self.connection = connection

    def __enter__(self):
        return self

    def __exit__(self, *_arguments):
        return False

    def executemany(self, query, parameters):
        assert "INSERT INTO chat_session_messages" in query
        self.connection.cursor_batches += 1
        self.connection.message_rows.extend(parameters)


class ScriptedConnection:
    def __init__(self, existing=False):
        self.existing = existing
        self.message_rows = []
        self.context_entries = 0
        self.cursor_batches = 0
        self.timestamp = datetime(2026, 7, 14, tzinfo=timezone.utc)
        self.session_row = (
            "session-1", "Původní název", "discord", "general",
            "openai", "chat-model", "medium", self.timestamp, self.timestamp,
        ) if existing else None

    def __enter__(self):
        self.context_entries += 1
        return self

    def __exit__(self, *_arguments):
        return False

    def execute(self, query, parameters=()):
        normalized = " ".join(query.split())
        if "FROM chat_sessions WHERE id=%s FOR UPDATE" in normalized:
            return ScriptedCursor(self.session_row)
        if normalized.startswith("INSERT INTO chat_sessions"):
            self.session_row = (
                parameters[0], parameters[1], parameters[2], parameters[3],
                parameters[4], parameters[5], parameters[6],
                self.timestamp, self.timestamp,
            )
            return ScriptedCursor(self.session_row)
        if "COALESCE(MAX(position),-1)+1" in normalized:
            return ScriptedCursor((len(self.message_rows),))
        if normalized.startswith("UPDATE chat_sessions SET updated_at"):
            return ScriptedCursor((
                self.session_row[0], self.session_row[1], self.timestamp, self.timestamp,
            ))
        raise AssertionError(f"Unexpected SQL: {normalized}")

    def cursor(self):
        return ScriptedBatchCursor(self)
