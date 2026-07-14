from typing import Callable, List, Optional, Sequence

import psycopg
from pgvector.psycopg import register_vector

from backend.archive_time import ArchiveTimeRange
from backend.chat_models import ChatScope
from backend.hybrid_fusion import (
    fuse_candidates, recency_multiplier, temporal_selection,
)
from backend.hybrid_search_sql import (
    apply_time_gap, expand_text_hit, fulltext_parameters, fulltext_sql,
    has_time_gap, neighbor_context, neighbor_query, vector_parameters,
    vector_search_sql,
)
from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import RetrievedChunk


class PostgresHybridRetrieval:
    _vector_search_sql = staticmethod(vector_search_sql)
    _fulltext_sql = staticmethod(fulltext_sql)
    _vector_parameters = staticmethod(vector_parameters)
    _fulltext_parameters = staticmethod(fulltext_parameters)
    _expand_text_hit = staticmethod(expand_text_hit)
    _neighbor_context = staticmethod(neighbor_context)
    _neighbor_query = staticmethod(neighbor_query)
    apply_time_gap = staticmethod(apply_time_gap)
    _has_time_gap = staticmethod(has_time_gap)
    _fuse_candidates = staticmethod(fuse_candidates)
    _temporal_selection = staticmethod(temporal_selection)
    _recency_multiplier = staticmethod(recency_multiplier)

    def __init__(self, database_dsn: str, ensure_schema: Callable[[], None]) -> None:
        self.database_dsn = database_dsn
        self.ensure_schema = ensure_schema

    def search(
        self, query: str, query_embedding: Sequence[float], limit: int,
        scope: Optional[ChatScope] = None,
        embedding_index_id: str = "default-openai", dimensions: int = 1536,
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[RetrievedChunk]:
        self.ensure_schema()
        if not 1 <= dimensions <= 4000:
            raise ValueError("HNSW halfvec dimensions must be between 1 and 4000.")
        try:
            with self._connect() as connection:
                connection.execute("SET LOCAL statement_timeout='10s'")
                vector_rows = connection.execute(
                    vector_search_sql(embedding_index_id, dimensions),
                    vector_parameters(query_embedding, scope, time_range),
                ).fetchall()
                text_rows = connection.execute(
                    fulltext_sql(), fulltext_parameters(query, scope, time_range),
                ).fetchall()
                text_candidates = [
                    expand_text_hit(connection, row, time_range) for row in text_rows
                ]
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid search failed.") from error
        if not vector_rows and not text_candidates:
            return []
        return fuse_candidates(
            vector_rows, text_rows, text_candidates, limit, time_range,
        )

    def _connect(self):
        connection = psycopg.connect(self.database_dsn, connect_timeout=10)
        register_vector(connection)
        return connection
