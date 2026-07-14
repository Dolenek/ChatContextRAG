from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from backend.chunking import ConversationAwareChunker
from backend.models import ChatRequest, ChatScope, SourceMessageInput
from backend.normalization import SourceMessageNormalizer
from backend.services import DatabaseChatService, DatabaseOverviewService
from backend.vector_models import NormalizedMessage, RetrievedChunk


def test_source_normalizer_cleans_text_and_derives_source_identity() -> None:
    message = SourceMessageInput(
        external_id=" 42 ", author="  Ada\tLovelace ",
        content="  first\tline \r\n\r\n\r\n second  ",
        channel="  general  room ", channel_id=" 20 ", guild_id=" 10 ",
        source_metadata={"thread": "release"},
    )

    normalized = SourceMessageNormalizer().normalize([message])[0]

    assert normalized.external_id == "42"
    assert normalized.author == "Ada Lovelace"
    assert normalized.content == "first line\n\nsecond"
    assert normalized.conversation_id == "20"
    assert normalized.conversation_label == "general room"
    assert normalized.container_id == "10"
    assert normalized.source_metadata == {"thread": "release"}


def test_source_normalizer_uses_unknown_author_for_whitespace_only_name() -> None:
    message = SourceMessageInput(external_id="1", author=" \t ", content="hello")

    normalized = SourceMessageNormalizer().normalize([message])[0]

    assert normalized.author == "Neznámý autor"


def test_source_message_contract_rejects_invalid_source_type_and_empty_content() -> None:
    with pytest.raises(ValidationError):
        SourceMessageInput(external_id="1", content="", source_type="Bad source")


def test_chunker_separates_sources_and_conversations() -> None:
    messages = [
        _message("1", "discord", "channel-1"),
        _message("2", "discord", "channel-2"),
        _message("3", "whatsapp", "channel-2"),
    ]

    chunks = ConversationAwareChunker().chunk(messages)

    assert len(chunks) == 3
    assert [chunk.metadata["source_type"] for chunk in chunks] == [
        "discord", "discord", "whatsapp",
    ]
    assert [chunk.metadata["conversation_id"] for chunk in chunks] == [
        "channel-1", "channel-2", "channel-2",
    ]


def test_chunker_rejects_an_unusable_character_limit() -> None:
    with pytest.raises(ValueError, match="at least 80"):
        ConversationAwareChunker(max_characters=79)


def test_chat_service_uses_hybrid_results_and_returns_source_identity() -> None:
    retrieved = _retrieved_chunk()
    hybrid = CapturingHybridRepository([retrieved])
    vector = CapturingVectorRepository([])
    embedding = FakeEmbeddingProvider()
    chat = FakeChatProvider()
    service = DatabaseChatService(vector, embedding, chat, hybrid, retrieval_limit=4)
    request = ChatRequest(
        question="Where is the plan?",
        scope=ChatScope(source_type="discord", conversation_id="20"),
    )

    response = service.answer(request)

    assert embedding.inputs == [["Where is the plan?"]]
    assert hybrid.calls[0][2] == 4
    assert vector.calls == []
    assert response.answer == "grounded answer"
    assert response.sources[0].source_message_ids == ["123"]
    assert response.sources[0].conversation_id == "20"


def test_chat_service_falls_back_to_vector_search_when_hybrid_is_empty() -> None:
    vector = CapturingVectorRepository([_retrieved_chunk()])
    service = DatabaseChatService(
        vector, FakeEmbeddingProvider(), FakeChatProvider(),
        CapturingHybridRepository([]),
    )

    response = service.answer(ChatRequest(question="Find the plan"))

    assert response.sources[0].content == "release plan"
    assert len(vector.calls) == 1


def test_chat_service_resolves_the_active_index_and_selected_chat_model() -> None:
    active_index = SimpleNamespace(
        embedding_index_id="index-1", provider_id="embeddings",
        model="embed-model", requested_dimensions=2, dimensions=2, status="ready",
    )
    registry = CapturingProviderRegistry()
    hybrid = CapturingHybridRepository([_retrieved_chunk()])
    service = DatabaseChatService(
        CapturingVectorRepository([]), None, None, hybrid,
        provider_registry=registry,
        index_repository=SimpleNamespace(active=lambda: active_index),
        default_chat_model="default-chat",
    )

    response = service.answer(ChatRequest(
        question="Find the plan", chat_provider_id="local", chat_model="chat-v2",
        reasoning_effort="high",
    ))

    assert registry.embedding_request == ("embeddings", "embed-model", 2)
    assert registry.chat_request == ("local", "chat-v2")
    assert hybrid.calls[0][4:] == ("index-1", 2)
    assert response.embedding_index_id == "index-1"
    assert response.chat_provider_id == "local"
    assert response.chat_model == "chat-v2"
    assert response.reasoning_effort == "high"


@pytest.mark.parametrize("active_index", [None, SimpleNamespace(status="building")])
def test_chat_service_requires_a_ready_active_index(active_index) -> None:
    service = DatabaseChatService(
        object(), None, None, object(), provider_registry=object(),
        index_repository=SimpleNamespace(active=lambda: active_index),
    )

    with pytest.raises(ValueError, match="ready embedding index"):
        service.answer(ChatRequest(question="Find the plan"))


def test_overview_service_combines_deletion_counts_and_prefers_raw_resume() -> None:
    vector = FakeOverviewRepository()
    raw = FakeRawOverviewRepository()
    service = DatabaseOverviewService(vector, raw)

    deleted = service.clear_database()
    resume = service.get_resume_point("20", "general")

    assert deleted == (7, 11)
    assert resume.message_id == "raw-oldest"
    assert vector.resume_calls == []


def test_overview_service_uses_legacy_resume_when_raw_has_no_match() -> None:
    vector = FakeOverviewRepository()
    raw = FakeRawOverviewRepository(message_id=None)

    resume = DatabaseOverviewService(vector, raw).get_resume_point("20", "general")

    assert resume.message_id == "legacy-oldest"
    assert vector.resume_calls == [("20", "general")]


def _message(external_id: str, source_type: str, conversation_id: str) -> NormalizedMessage:
    return NormalizedMessage(
        external_id=external_id, author="Ada", content=f"message {external_id}",
        timestamp=datetime(2026, 7, 13, tzinfo=timezone.utc), channel=conversation_id,
        channel_id=conversation_id if source_type == "discord" else None,
        guild_id="10" if source_type == "discord" else None,
        source_type=source_type, conversation_id=conversation_id,
        conversation_label=conversation_id,
    )


def _retrieved_chunk() -> RetrievedChunk:
    return RetrievedChunk(
        content="release plan", authors=["Ada"], channel="general",
        started_at=None, similarity_score=0.8, source_message_ids=["123"],
        channel_id="20", guild_id="10", source_type="discord",
        conversation_id="20",
    )


class FakeEmbeddingProvider:
    def __init__(self) -> None:
        self.inputs = []

    def embed_texts(self, texts):
        self.inputs.append(list(texts))
        return [[0.1, 0.2] for _text in texts]


class FakeChatProvider:
    def answer(self, question, history, sources, reasoning_effort=None):
        assert question
        assert history == []
        assert sources
        if reasoning_effort is not None:
            assert reasoning_effort == "high"
        return "grounded answer"


class CapturingVectorRepository:
    def __init__(self, results) -> None:
        self.results = results
        self.calls = []

    def search_similar(self, embedding, limit, scope):
        self.calls.append((embedding, limit, scope))
        return self.results


class CapturingHybridRepository:
    def __init__(self, results) -> None:
        self.results = results
        self.calls = []

    def search_hybrid(self, *arguments):
        self.calls.append(arguments)
        return self.results


class CapturingProviderRegistry:
    def create_embedding_provider(self, provider_id, model, dimensions):
        self.embedding_request = (provider_id, model, dimensions)
        return FakeEmbeddingProvider()

    def create_chat_provider(self, provider_id, model):
        self.chat_request = (provider_id, model)
        return FakeChatProvider()


class FakeOverviewRepository:
    def __init__(self) -> None:
        self.resume_calls = []

    def delete_all(self):
        return 5

    def find_oldest_source_message_id(self, channel_id, channel_name):
        self.resume_calls.append((channel_id, channel_name))
        return "legacy-oldest"


class FakeRawOverviewRepository:
    def __init__(self, message_id="raw-oldest") -> None:
        self.message_id = message_id

    def delete_all(self):
        return 2, 11

    def find_oldest_message_id(self, _channel_id, _channel_name):
        return self.message_id
