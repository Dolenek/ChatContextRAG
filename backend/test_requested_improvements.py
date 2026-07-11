import re
from types import SimpleNamespace

import pytest

from backend.chunking import ConversationAwareChunker
from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.indexing_worker import PersistentIndexingWorker
from backend.raw_schema import raw_schema_statements
from backend.services import DatabaseChatService
from backend.vector_models import NormalizedMessage, RetrievedChunk


def test_raw_schema_indexes_content_occurrences_in_message_order() -> None:
    schema = "\n".join(raw_schema_statements())

    assert "discord_messages_content_order" in schema
    assert "ON discord_messages(content_hash, message_order)" in schema


def test_vector_candidates_are_limited_before_source_hash_aggregation() -> None:
    query = PostgresHybridRetrieval._vector_search_sql()

    assert "WITH vector_candidates AS MATERIALIZED" in query
    assert query.index("LIMIT %s") < query.index("rag_chunk_messages")
    assert "metadata->>'channel_id'" in query


def test_fulltext_anchors_use_the_content_order_index() -> None:
    query = PostgresHybridRetrieval._fulltext_sql()

    assert "ORDER BY message_order DESC LIMIT 1" in query
    assert "ORDER BY message_order LIMIT 1" in query
    assert "ORDER BY sent_at" not in query


def test_long_message_chunks_preserve_context_with_bounded_overlap() -> None:
    content = " ".join(f"strategy-{index}" for index in range(80))
    message = NormalizedMessage(
        external_id="1", author="Ada", content=content, timestamp=None,
        channel="guide", channel_id="20", guild_id="10",
    )
    chunks = ConversationAwareChunker(
        max_characters=180, overlap_characters=36,
    ).chunk([message])

    assert len(chunks) > 1
    assert all(len(chunk.content) <= 180 for chunk in chunks)
    assert all(chunk.content.startswith("[Pokračování]") for chunk in chunks[1:])
    assert _words(chunks[0].content)[-2:] == _overlap_words(chunks[1].content)
    assert "strategy-79" in chunks[-1].content


def _words(content: str) -> list:
    return re.findall(r"strategy-\d+", content)


def _overlap_words(content: str) -> list:
    return _words(content)[:2]


class DimensionedEmbeddingProvider:
    model_name = "fake"
    dimensions = 2


def test_indexer_rejects_missing_or_malformed_embeddings() -> None:
    worker = PersistentIndexingWorker(
        SimpleNamespace(), SimpleNamespace(), ConversationAwareChunker(),
        DimensionedEmbeddingProvider(),
    )

    with pytest.raises(ValueError, match="1 vectors for 2 chunks"):
        worker._attach_embeddings([object(), object()], [[0.1, 0.2]])
    with pytest.raises(ValueError, match="unexpected vector dimension"):
        worker._attach_embeddings([object()], [[0.1]])


def test_chat_sources_keep_discord_identity_for_ui_deep_links() -> None:
    chunk = RetrievedChunk(
        content="Grounded answer", authors=["Ada"], channel="guide",
        started_at=None, similarity_score=0.5, source_message_ids=["123"],
        channel_id="20", guild_id="10",
    )

    source = DatabaseChatService._to_sources([chunk])[0]

    assert source.source_message_ids == ["123"]
    assert source.channel_id == "20"
    assert source.guild_id == "10"
