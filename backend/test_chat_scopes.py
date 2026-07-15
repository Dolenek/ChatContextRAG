from backend.hybrid_retrieval import PostgresHybridRetrieval
from backend.models import ChatScope
from backend.read_models.reader import PostgresReadModelReader
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
    assert "m.source_type=%s" in fulltext_query
    assert "m.conversation_id=%s" in fulltext_query
    assert "source_messages" in fulltext_query


def test_scope_catalog_reads_only_the_active_index_projection() -> None:
    connection = ScopeConnection()

    result = PostgresReadModelReader("unused").scopes(connection)

    queries = " ".join(connection.queries)
    assert "chat_scope_read_model" in queries
    assert "rag_chunk_messages" not in queries
    assert "source_messages" not in queries
    assert result.scopes[0].conversation_id == "20"
    assert result.scopes[0].message_count == 12


class QueryResult:
    def __init__(self, row=None, rows=None) -> None:
        self.row = row
        self.rows = rows or []

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.rows


class ScopeConnection:
    def __init__(self) -> None:
        self.queries = []

    def execute(self, query, _parameters=None):
        normalized = " ".join(query.split())
        self.queries.append(normalized)
        if "active_embedding_index_id" in normalized:
            return QueryResult(("index-1",))
        if "chat_scope_read_model" in normalized:
            return QueryResult(rows=[("discord", "20", "general", "server", 12)])
        if "embedding_index_read_summary" in normalized:
            return QueryResult((2, 12, 0, None))
        if "read_model_refresh_state" in normalized:
            return QueryResult((1, 1, "ready", None, None))
        raise AssertionError(normalized)
