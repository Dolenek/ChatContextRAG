from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from openai import OpenAIError

from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.archive_time import resolve_archive_time_range
from backend.models import ChatHistoryTurn, ChatScope
from backend.openai_gateway import (
    ExternalIntegrationError, OpenAIChatCompletionProvider, OpenAIEmbeddingProvider,
)


def test_hybrid_parameter_builders_apply_the_same_scope_to_both_searches() -> None:
    scope = ChatScope(source_type="whatsapp", conversation_id="family")

    vector_parameters = PostgresHybridRetrieval._vector_parameters([0.1, 0.2], scope)
    text_parameters = PostgresHybridRetrieval._fulltext_parameters("release plan", scope)

    assert tuple(vector_parameters[1:5]) == ("whatsapp", "whatsapp", "family", "family")
    assert text_parameters.count("whatsapp") == 6
    assert text_parameters.count("family") == 6
    assert text_parameters[0] == "release plan"
    assert text_parameters[-1] == 32


def test_hybrid_parameter_builders_apply_prague_utc_interval() -> None:
    scope = ChatScope(source_type="discord", conversation_id="cirkus")
    time_range = resolve_archive_time_range(
        datetime(2026, 6, 10).date(), datetime(2026, 6, 17).date(),
        "Europe/Prague",
    )

    vector = PostgresHybridRetrieval._vector_parameters([0.1, 0.2], scope, time_range)
    fulltext = PostgresHybridRetrieval._fulltext_parameters(
        "release discussion", scope, time_range,
    )

    assert vector[5:9] == (
        time_range.start_at, time_range.start_at, time_range.end_at, time_range.end_at,
    )
    assert fulltext.count(time_range.start_at) == 6
    assert fulltext.count(time_range.end_at) == 6
    assert "COALESCE(ended_at,started_at)>=" in PostgresHybridRetrieval._vector_search_sql()
    assert "m.sent_at>=" in PostgresHybridRetrieval._fulltext_sql()


def test_temporal_selection_covers_nonempty_buckets_before_global_fill() -> None:
    time_range = resolve_archive_time_range(
        datetime(2026, 6, 10).date(), datetime(2026, 6, 17).date(), "UTC",
    )
    candidates = [
        (1.0 - index / 100, SimpleNamespace(
            started_at=time_range.start_at + timedelta(days=day), label=label,
        ))
        for index, (day, label) in enumerate([
            (0, "best-early"), (0, "second-early"), (3, "middle"), (6, "late"),
        ])
    ]

    selected = PostgresHybridRetrieval._temporal_selection(candidates, 3, time_range)

    assert {candidate[1].label for candidate in selected} == {
        "best-early", "middle", "late",
    }


def test_hybrid_search_rejects_dimensions_outside_pgvector_limit() -> None:
    schema_calls = []
    retrieval = PostgresHybridRetrieval("unused", lambda: schema_calls.append(True))

    with pytest.raises(ValueError, match="between 1 and 4000"):
        retrieval.search("query", [0.1], 8, dimensions=4001)

    assert schema_calls == [True]


def test_filtered_hybrid_search_enables_iterative_hnsw_scan(monkeypatch) -> None:
    connection = RecordingSearchConnection()
    retrieval = PostgresHybridRetrieval("unused", lambda: None)
    retrieval._connect = lambda: connection
    monkeypatch.setattr("backend.hybrid_retrieval.register_vector", lambda _connection: None)
    time_range = resolve_archive_time_range(
        datetime(2026, 6, 10).date(), datetime(2026, 6, 17).date(), "UTC",
    )

    results = retrieval.search(
        "query", [0.1, 0.2], 8,
        ChatScope(source_type="discord", conversation_id="cirkus"),
        time_range=time_range, dimensions=2,
    )

    assert results == []
    assert connection.queries[:2] == [
        "SET LOCAL statement_timeout='10s'",
        "SET LOCAL hnsw.iterative_scan='strict_order'",
    ]


def test_neighbor_context_keeps_only_the_anchor_time_segment() -> None:
    started = datetime(2026, 7, 13, 8, tzinfo=timezone.utc)
    rows = [
        ("Old", "stale", started, "general", "1", "20", "10", "discord", "20"),
        ("Ada", "anchor", started + timedelta(hours=2), "general", "2", "20", "10", "discord", "20"),
        ("Bob", "reply", started + timedelta(hours=2, minutes=5), "general", "3", "20", "10", "discord", "20"),
    ]

    context = PostgresHybridRetrieval._neighbor_context(FakeConnection(rows), "2")

    assert "stale" not in context["content"]
    assert "anchor" in context["content"]
    assert context["authors"] == ["Ada", "Bob"]
    assert context["source_message_ids"] == ["2", "3"]
    assert context["conversation_id"] == "20"


def test_neighbor_context_returns_an_empty_contract_without_rows() -> None:
    context = PostgresHybridRetrieval._neighbor_context(FakeConnection([]), "missing")

    assert context == {
        "content": "", "authors": [], "channel": None, "started_at": None,
    }


def test_reciprocal_rank_fusion_combines_matches_and_keeps_text_only_context() -> None:
    vector_rows = [(
        "chunk-1", "vector context", ["Ada"], "general", None, 0.8,
        ["1"], "20", "10", "discord", "20", ["hash-1"],
    )]
    text_rows = [("hash-1", 1.0), ("hash-2", 0.5)]
    text_candidates = [
        {"hash": "hash-1", "context": {"content": "duplicate"}},
        {"hash": "hash-2", "context": {
            "content": "text context", "authors": ["Bob"], "channel": "general",
            "started_at": None, "source_message_ids": ["2"], "channel_id": "20",
            "guild_id": "10", "source_type": "discord", "conversation_id": "20",
        }},
    ]

    results = PostgresHybridRetrieval("unused", lambda: None)._fuse_candidates(
        vector_rows, text_rows, text_candidates, 8,
    )

    assert [result.content for result in results] == ["vector context", "text context"]
    assert results[0].similarity_score > results[1].similarity_score
    assert results[1].source_message_ids == ["2"]


def test_recency_multiplier_is_bounded_and_rewards_recent_content() -> None:
    recent = datetime.now(timezone.utc)
    old = recent - timedelta(days=20_000)

    assert PostgresHybridRetrieval._recency_multiplier(None) == 1.0
    assert 1.09 < PostgresHybridRetrieval._recency_multiplier(recent) <= 1.1
    assert PostgresHybridRetrieval._recency_multiplier(old) > 1.0
    assert PostgresHybridRetrieval._recency_multiplier(recent) > (
        PostgresHybridRetrieval._recency_multiplier(old)
    )


def test_responses_adapter_builds_grounded_input_and_limits_history() -> None:
    calls = []
    provider = OpenAIChatCompletionProvider("key", "chat-model")
    provider.client = SimpleNamespace(responses=SimpleNamespace(
        create=lambda **kwargs: calls.append(kwargs) or SimpleNamespace(output_text="answer"),
    ))
    history = [ChatHistoryTurn(role="user", content=f"turn {index}") for index in range(10)]
    source = SimpleNamespace(authors=["Ada"], channel="general", content="release plan")

    answer = provider.answer("When?", history, [source])

    assert answer == "answer"
    assert calls[0]["model"] == "chat-model"
    assert len(calls[0]["input"]) == 10
    assert calls[0]["input"][0]["content"] == "turn 2"
    assert calls[0]["input"][-2]["role"] == "developer"
    assert "release plan" in calls[0]["input"][-2]["content"]


def test_embedding_provider_translates_sdk_errors_to_integration_error() -> None:
    provider = OpenAIEmbeddingProvider("key", "embed-model", 2)
    provider.client = SimpleNamespace(embeddings=SimpleNamespace(
        create=lambda **_kwargs: (_ for _ in ()).throw(OpenAIError("offline")),
    ))

    with pytest.raises(ExternalIntegrationError, match="embeddings API"):
        provider.embed_texts(["hello"])


class FakeResult:
    def __init__(self, rows) -> None:
        self.rows = rows

    def fetchall(self):
        return self.rows


class FakeConnection:
    def __init__(self, rows) -> None:
        self.rows = rows

    def execute(self, _query, parameters=None):
        assert parameters
        return FakeResult(self.rows)


class RecordingSearchConnection:
    def __init__(self) -> None:
        self.queries = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, query, parameters=None):
        self.queries.append(query)
        return FakeResult([])
