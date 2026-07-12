from backend.chat_scope_catalog import PostgresChatScopeCatalog
from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.models import ChatScope
from backend.services import DatabaseChatService


class CapturingHybridRepository:
    def __init__(self, results) -> None:
        self.results = results
        self.scope = None

    def search_hybrid(self, _query, _embedding, _limit, scope):
        self.scope = scope
        return self.results


class CapturingVectorRepository:
    def __init__(self) -> None:
        self.scope = None

    def search_similar(self, _embedding, _limit, scope):
        self.scope = scope
        return []


def test_chat_scope_reaches_hybrid_and_legacy_retrieval() -> None:
    scope = ChatScope(source_type="discord", conversation_id="channel-20")
    hybrid_repository = CapturingHybridRepository([])
    vector_repository = CapturingVectorRepository()
    service = DatabaseChatService(
        vector_repository, object(), object(), hybrid_repository,
    )

    assert service._retrieve("deadline", [0.1, 0.2], scope) == []
    assert hybrid_repository.scope == scope
    assert vector_repository.scope == scope


def test_hybrid_queries_filter_vector_and_fulltext_candidates() -> None:
    vector_query = PostgresHybridRetrieval._vector_search_sql()
    fulltext_query = PostgresHybridRetrieval._fulltext_sql()

    assert "metadata->>'source_type'" in vector_query
    assert "metadata->>'conversation_id'" in vector_query
    assert "%s::text IS NULL" in vector_query
    assert "m.channel_id=%s" in fulltext_query
    assert "%s='discord'" in fulltext_query


def test_scope_catalog_merges_new_and_legacy_chunk_counts() -> None:
    rows = [
        ("discord", "20", "general", "10", 12),
        ("discord", "20", "general", "10", 8),
        ("whatsapp", "family", "Family", None, 30),
    ]

    scopes = PostgresChatScopeCatalog._merge_rows(rows)

    assert [(scope.source_type, scope.conversation_id) for scope in scopes] == [
        ("discord", "20"), ("whatsapp", "family"),
    ]
    assert scopes[0].message_count == 12
