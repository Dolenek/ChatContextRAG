from datetime import datetime, timezone

from backend.adaptive_evidence import EvidenceRegistry
from backend.archive_tool_contracts import CONTEXT_TOOL, SEARCH_TOOL, TEXT_SEARCH_TOOL
from backend.archive_tools import ScopedArchiveTools
from backend.chat_models import ChatScope, ChatSource
from backend.vector_models import NormalizedMessage, RetrievedChunk


def test_evidence_registry_deduplicates_truncates_and_caps_messages():
    registry = EvidenceRegistry(4000)
    payload = registry.add_sources([
        _source("m1", "a" * 3000), _source("m1", "duplicate"),
        _source("m2", "b" * 2000),
    ], "search")

    assert [item["evidence_id"] for item in payload["messages"]] == ["E1", "E1", "E2"]
    assert payload["messages"][1]["already_provided"] is True
    assert len(payload["messages"][2]["content"]) == 1000
    assert payload["messages"][2]["content_truncated"] is True
    assert payload["budget_exhausted"] is True
    assert len(registry.sources()) == 2

    cap = EvidenceRegistry(48000)
    capped_payload = cap.add_sources(
        [_source(f"m{index}", "x") for index in range(60)], "search",
    )
    assert len(cap.sources()) == 48
    assert capped_payload["budget_exhausted"] is True


def test_scoped_tools_limit_chunks_and_keep_context_in_anchor_conversation():
    chunks = [
        RetrievedChunk(
            content=str(index), authors=["Alice"], channel="general",
            started_at=None, similarity_score=1.0, source_message_ids=[f"m{index}"],
        )
        for index in range(10)
    ]
    projector = RecordingProjector()
    reader = RecordingContextReader()
    scope = ChatScope(source_type="discord", conversation_id="conversation-1")
    tools = ScopedArchiveTools(lambda _query, _deadline: chunks, projector, reader, scope)

    tools.search("query", 1.0)
    context_sources = tools.read_context(_source("m1", "anchor"), 10, 10)

    assert len(projector.chunks) == 8
    assert reader.arguments == ("m1", 10, 10, scope)
    assert context_sources[0].evidence_origin == "context"
    assert context_sources[0].conversation_id == "conversation-1"
    assert "scope" not in SEARCH_TOOL.parameters["properties"]
    assert "scope" not in TEXT_SEARCH_TOOL.parameters["properties"]
    assert "scope" not in CONTEXT_TOOL.parameters["properties"]


def _source(message_id, content):
    return ChatSource(
        author="Alice", content=content,
        timestamp=datetime(2026, 1, 2, tzinfo=timezone.utc), channel="general",
        similarity_score=0.8, source_message_ids=[message_id],
        source_type="discord", conversation_id="conversation-1",
    )


class RecordingProjector:
    def __init__(self):
        self.chunks = []

    def project_chunks(self, chunks):
        self.chunks = list(chunks)
        return []


class RecordingContextReader:
    def __init__(self):
        self.arguments = None

    def load_message_context(self, anchor_id, before_count, after_count, scope):
        self.arguments = (anchor_id, before_count, after_count, scope)
        return [NormalizedMessage(
            external_id="m0", author="Bob", content="context",
            timestamp=None, channel="general", channel_id="channel-1",
            guild_id="guild-1", source_type="discord",
            conversation_id="conversation-1", conversation_label="General",
        )]
