import json
from contextlib import nullcontext
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from backend.agent_protocol import AgentToolCall, AgentTurn
from backend.archive_text_search import ArchiveTextSearchResult
from backend.chat_models import ChatSource
from backend.discord_bot_models import (
    DiscordBotAnswerRequest, DiscordBotDeliveryUpdate, DiscordBotModelSettings,
    DiscordBotSettingsView,
    DiscordGuildPermissions, DiscordPermissionSubject, DiscordRecentMessage,
)
from backend.discord_bot_repository import DiscordBotRepository
from backend.discord_bot_schema import discord_bot_schema_statements
from backend.discord_bot_service import DiscordBotService
from backend.vector_models import NormalizedMessage


NOW = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)


def test_discord_schema_contains_normalized_settings_permissions_and_audit() -> None:
    schema = "\n".join(discord_bot_schema_statements())

    assert "CREATE TABLE IF NOT EXISTS discord_bot_settings" in schema
    assert "CREATE TABLE IF NOT EXISTS discord_bot_guilds" in schema
    assert "CREATE TABLE IF NOT EXISTS discord_bot_permission_subjects" in schema
    assert "CREATE TABLE IF NOT EXISTS discord_bot_answers" in schema
    assert "CREATE TABLE IF NOT EXISTS discord_bot_answer_messages" in schema
    assert "parent_answer_id TEXT REFERENCES discord_bot_answers" in schema
    assert "ON DELETE CASCADE" in schema


def test_permission_contract_keeps_role_and_user_capabilities_independent() -> None:
    permissions = DiscordGuildPermissions(
        guild_id="guild", guild_name="Workspace",
        sync_subjects=[permission("role", "sync")],
        ask_subjects=[permission("user", "ask")],
    )

    rows = DiscordBotRepository._permission_rows(permissions)

    assert rows == [
        ("guild", "sync", "role", "sync", "sync"),
        ("guild", "ask", "user", "ask", "ask"),
    ]


def test_reply_history_is_limited_to_last_eight_user_assistant_items() -> None:
    rows = [(f"question-{index}", f"answer-{index}") for index in range(6)]
    repository = DiscordBotRepository(lambda: None, lambda: nullcontext(FakeRows(rows)))

    history = repository.history_for("parent")

    assert len(history) == 8
    assert history[0].content == "question-2"
    assert history[-1].content == "answer-5"


def test_recent_room_evidence_is_cited_and_audited_without_an_index() -> None:
    repository = FakeDiscordRepository("Termín je v pátek [E1].")
    service = create_service(repository)

    result = service.answer(answer_request([recent_message("source", "Termín je v pátek.")]))

    assert result.basis == "room_context"
    assert result.answer == "Termín je v pátek [E1]."
    assert result.evidence[0].cited is True
    assert result.evidence[0].origin == "recent"
    assert "archive_index_unavailable" in result.warnings
    assert repository.completed[2] == "room_context"


def test_irrelevant_room_context_uses_unlabelled_general_knowledge_fallback() -> None:
    repository = FakeDiscordRepository("Barack Obama se narodil 4. srpna 1961.")
    service = create_service(repository)

    result = service.answer(answer_request([recent_message("source", "Termín je v pátek.")]))

    assert result.basis == "general_knowledge"
    assert "fallback" not in result.answer.lower()
    assert result.evidence[0].cited is False
    assert result.answer.startswith("Barack Obama")


def test_invalid_or_unlinkable_citations_do_not_claim_room_grounding() -> None:
    repository = FakeDiscordRepository("Obecná odpověď [E9].")
    service = create_service(repository)

    result = service.answer(answer_request([]))

    assert result.basis == "general_knowledge"
    assert "[E9]" not in result.answer


def test_archive_search_is_room_scoped_and_filters_trigger_and_future_messages() -> None:
    sources = [
        archive_source("before", NOW - timedelta(minutes=1)),
        archive_source("trigger", NOW),
        archive_source("future", NOW + timedelta(minutes=1)),
    ]
    repository = FakeDiscordRepository("Relevantní podklad [E1].")
    hybrid = FakeHybridRepository()
    service = create_service(
        repository, active_index=True, hybrid=hybrid, projected_sources=sources,
    )

    result = service.answer(answer_request([]))

    assert result.basis == "room_context"
    assert [item.message_id for item in result.evidence] == ["before"]
    assert hybrid.scope.source_type == "discord"
    assert hybrid.scope.conversation_id == "room"
    assert hybrid.time_range.end_at == NOW


def test_archive_retrieval_failure_keeps_recent_and_general_answer_available() -> None:
    repository = FakeDiscordRepository("Obecná odpověď bez citace.")
    service = create_service(
        repository, active_index=True, hybrid=FailingHybridRepository(),
    )

    result = service.answer(answer_request([]))

    assert result.basis == "general_knowledge"
    assert "archive_retrieval_failed" in result.warnings


def test_adaptive_direct_text_search_reads_raw_room_before_indexing() -> None:
    repository = FakeDiscordRepository()
    repository.model = repository.model.model_copy(update={"retrieval_mode": "adaptive"})
    provider = DirectTextAgentProvider()
    text_search = RecordingTextSearch()
    service = DiscordBotService(
        repository, FakeProviderRegistry(provider),
        SimpleNamespace(active=lambda: None), FakeHybridRepository(),
        SimpleNamespace(project_chunks=lambda _chunks: []), text_search,
        archive_text_searcher=text_search,
    )

    result = service.answer(answer_request([]))

    assert result.basis == "room_context"
    assert result.answer == "First mention [E1]."
    assert "archive_index_unavailable" in result.warnings
    assert text_search.arguments["scope"].conversation_id == "room"
    assert text_search.arguments["excluded_message_ids"] == ("trigger",)
    assert text_search.arguments["maximum_timestamp"] == NOW
    assert repository.completed[5][0]["tool_name"] == "search_text_occurrences"


def test_generation_failure_persists_safe_warning_without_provider_payload() -> None:
    repository = FakeDiscordRepository(error=RuntimeError("provider offline"))
    service = create_service(repository)
    request = answer_request([])
    request.warnings = ["recent_context_unavailable"]

    try:
        service.answer(request)
        raise AssertionError("generation should fail")
    except RuntimeError:
        pass

    assert repository.failed == (
        "answer-1", "RuntimeError", ["recent_context_unavailable", "provider offline"],
    )


def test_delivery_contract_requires_ids_only_for_success() -> None:
    failed = DiscordBotDeliveryUpdate(
        status="failed", warning="discord_delivery_failed",
    )
    assert failed.message_ids == []

    try:
        DiscordBotDeliveryUpdate(status="delivered")
        raise AssertionError("delivered audit must require a message ID")
    except ValueError as error:
        assert "requires a message ID" in str(error)


def create_service(
    repository, active_index=False, hybrid=None, projected_sources=None,
) -> DiscordBotService:
    provider = FakeChatProvider(repository.answer_text, repository.error)
    registry = FakeProviderRegistry(provider)
    index = SimpleNamespace(
        active=lambda: SimpleNamespace(
            status="ready", provider_id="openai", model="embed",
            requested_dimensions=3, embedding_index_id="index", dimensions=3,
        ) if active_index else None,
    )
    projector = SimpleNamespace(project_chunks=lambda _chunks: projected_sources or [])
    return DiscordBotService(
        repository, registry, index, hybrid or FakeHybridRepository(),
        projector, SimpleNamespace(),
    )


def answer_request(recent_context) -> DiscordBotAnswerRequest:
    return DiscordBotAnswerRequest(
        guild_id="guild", guild_name="Workspace", channel_id="room",
        channel_name="general", requester_id="user", requester_name="Ada",
        trigger_message_id="trigger", trigger_type="mention", trigger_at=NOW,
        question="Kdy je termín?", recent_context=recent_context,
    )


def recent_message(message_id, content) -> DiscordRecentMessage:
    return DiscordRecentMessage(
        message_id=message_id, author="Ada", content=content,
        timestamp=NOW - timedelta(minutes=2), channel_id="room", guild_id="guild",
    )


def archive_source(message_id, timestamp) -> ChatSource:
    return ChatSource(
        author="Ada", content=message_id, timestamp=timestamp, channel="general",
        similarity_score=1.0, source_message_ids=[message_id], channel_id="room",
        guild_id="guild", conversation_id="room", source_type="discord",
    )


def permission(subject_type, subject_id) -> DiscordPermissionSubject:
    return DiscordPermissionSubject(
        subject_type=subject_type, subject_id=subject_id, display_name=subject_id,
    )


class FakeRows:
    def __init__(self, rows):
        self.rows = rows

    def execute(self, _query, _parameters):
        return self

    def fetchall(self):
        return self.rows


class FakeDiscordRepository:
    def __init__(self, answer_text=None, error=None):
        self.answer_text = answer_text
        self.error = error
        self.completed = None
        self.failed = None
        self.model = DiscordBotModelSettings(
            chat_provider_id="openai", chat_model="gpt-test",
            retrieval_mode="deterministic",
        )

    def settings(self):
        return DiscordBotSettingsView(model=self.model)

    def parent_for_message(self, _message_id):
        return None

    def create_answer(self, _request, _model, _parent_id):
        return "answer-1"

    def history_for(self, _parent_id):
        return []

    def complete_answer(self, answer_id, *completion):
        self.completed = (answer_id, *completion)

    def fail_answer(self, answer_id, error_code, warnings):
        self.failed = (answer_id, error_code, warnings)


class FakeChatProvider:
    def __init__(self, answer_text, error):
        self.answer_text = answer_text
        self.error = error

    def answer_with_evidence(self, _question, _history, _evidence, _instructions, _reasoning):
        if self.error:
            raise self.error
        return self.answer_text


class FakeEmbeddingProvider:
    def embed_texts(self, _texts):
        return [[0.1, 0.2, 0.3]]


class FakeProviderRegistry:
    def __init__(self, chat_provider):
        self.chat_provider = chat_provider

    def create_chat_provider(self, _provider_id, _model):
        return self.chat_provider

    def create_embedding_provider(self, _provider_id, _model, _dimensions):
        return FakeEmbeddingProvider()


class FakeHybridRepository:
    def search_hybrid(self, _query, _embedding, _limit, scope, _index_id, _dimensions, time_range):
        self.scope = scope
        self.time_range = time_range
        return [SimpleNamespace()]


class FailingHybridRepository:
    def search_hybrid(self, *_arguments):
        raise RuntimeError("archive offline")


class DirectTextAgentProvider:
    def __init__(self):
        self.turn = 0

    def create_agent_session(self, *_arguments):
        return self

    def next_turn(self, _tools, _choice, _outputs=()):
        self.turn += 1
        if self.turn == 1:
            arguments = json.dumps({
                "patterns": ["deadlock"], "match_mode": "term_prefix",
                "operator": "all", "sort": "oldest", "limit": 3,
                "date_from": None, "date_to": None,
            })
            return AgentTurn("", [AgentToolCall(
                "direct-1", "search_text_occurrences", arguments,
            )])
        return AgentTurn("First mention [E1].", [])


class RecordingTextSearch:
    def __init__(self):
        self.arguments = None

    def search_text_occurrences(self, **arguments):
        self.arguments = arguments
        message = NormalizedMessage(
            external_id="raw-before-index", author="Ada", content="deadlocku",
            timestamp=NOW - timedelta(days=1), channel="general",
            channel_id="room", guild_id="guild", source_type="discord",
            conversation_id="room", message_order=1,
        )
        return ArchiveTextSearchResult([message], True, "source_order")

    def load_message_context(self, *_arguments):
        return []
