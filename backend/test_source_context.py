from datetime import datetime, timezone

from backend.chat_sessions import PostgresChatSessionRepository
from backend.models import ChatSessionDetail, ChatSessionMessage, ChatSource
from backend.services import DatabaseChatService
from backend.source_context import SourceContextProjector
from backend.vector_models import NormalizedMessage, RetrievedChunk


class MemoryMessageReader:
    def __init__(self, messages):
        self.messages = {message.external_id: message for message in messages}
        self.requests = []

    def load_messages_by_ids(self, message_ids):
        self.requests.append(list(message_ids))
        return [self.messages[item] for item in message_ids if item in self.messages]


def test_projector_returns_ranked_deduplicated_source_messages() -> None:
    reader = MemoryMessageReader([
        _message("first", "Ada", 1), _message("second", "Ben", 2),
        _message("third", "Cora", 3),
    ])
    projector = SourceContextProjector(reader)
    chunks = [
        _chunk(["first", "second"], 0.9),
        _chunk(["second", "third"], 0.7),
    ]

    sources = projector.project_chunks(chunks)

    assert [source.source_message_ids for source in sources] == [
        ["first"], ["second"], ["third"],
    ]
    assert [source.author for source in sources] == ["Ada", "Ben", "Cora"]
    assert [source.similarity_score for source in sources] == [0.9, 0.9, 0.7]
    assert reader.requests == [["first", "second", "third"]]


def test_projector_preserves_chunk_fallback_when_raw_message_is_missing() -> None:
    projector = SourceContextProjector(MemoryMessageReader([_message("known", "Ada", 1)]))
    chunk = _chunk(["known", "missing"], 0.8)

    sources = projector.project_chunks([chunk])

    assert sources[0].source_message_ids == ["known"]
    assert sources[1].source_message_ids == ["known", "missing"]
    assert sources[1].content == "chunk context"


def test_projector_expands_sources_saved_by_older_chat_sessions() -> None:
    projector = SourceContextProjector(MemoryMessageReader([
        _message("one", "Ada", 1), _message("two", "Ben", 2),
    ]))
    legacy_source = ChatSource(
        author="Ada, Ben", content="legacy chunk", timestamp=None,
        channel="general", similarity_score=0.75,
        source_message_ids=["one", "two"],
    )

    sources = projector.expand_sources([legacy_source])

    assert [source.source_message_ids for source in sources] == [["one"], ["two"]]


def test_chat_session_detail_exposes_stored_message_timestamp() -> None:
    timestamp = datetime(2026, 7, 14, 12, 30, tzinfo=timezone.utc)
    session_row = (
        "session", "Title", "discord", "general", "openai", "chat",
        None, timestamp, timestamp,
    )

    detail = PostgresChatSessionRepository._detail(
        session_row, [("user", "Question", [], timestamp)],
    )

    assert detail.messages[0].created_at == timestamp


def test_chat_service_normalizes_sources_when_restoring_an_older_session() -> None:
    timestamp = datetime(2026, 7, 14, 12, 30, tzinfo=timezone.utc)
    legacy_source = ChatSource(
        author="Ada, Ben", content="legacy chunk", timestamp=None,
        channel="general", similarity_score=0.75,
        source_message_ids=["one", "two"],
    )
    session = ChatSessionDetail(
        session_id="session", title="Title", created_at=timestamp, updated_at=timestamp,
        messages=[ChatSessionMessage(
            role="assistant", content="Answer", sources=[legacy_source], created_at=timestamp,
        )],
    )
    repository = MemorySessionRepository(session)
    projector = SourceContextProjector(MemoryMessageReader([
        _message("one", "Ada", 1), _message("two", "Ben", 2),
    ]))
    service = DatabaseChatService(
        repository=None, embedding_provider=None, chat_provider=None,
        chat_session_repository=repository, source_context_projector=projector,
    )

    restored = service.get_session("session")

    assert [source.author for source in restored.messages[0].sources] == ["Ada", "Ben"]


class MemorySessionRepository:
    def __init__(self, session):
        self.session = session

    def get(self, session_id):
        assert session_id == self.session.session_id
        return self.session


def _message(message_id: str, author: str, order: int) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=message_id, author=author, content=f"Message {message_id}",
        timestamp=datetime(2025, 3, 12, 14, order, tzinfo=timezone.utc),
        channel="general", channel_id="20", guild_id="10",
        source_type="discord", conversation_id="20",
        conversation_label="projekt-alpha", message_order=order,
    )


def _chunk(message_ids, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        content="chunk context", authors=["Ada", "Ben"], channel="projekt-alpha",
        started_at=None, similarity_score=score, source_message_ids=message_ids,
        channel_id="20", guild_id="10", source_type="discord",
        conversation_id="20",
    )
