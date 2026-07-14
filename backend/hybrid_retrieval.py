import math
from datetime import datetime, timezone
from typing import Callable, List, Optional, Sequence

import psycopg
from pgvector import HalfVector
from pgvector.psycopg import register_vector

from backend.openai_gateway import ExternalIntegrationError
from backend.models import ChatScope
from backend.vector_models import RetrievedChunk


class PostgresHybridRetrieval:
    def __init__(self, database_dsn: str, ensure_schema: Callable[[], None]) -> None:
        self.database_dsn = database_dsn
        self.ensure_schema = ensure_schema

    def search(
        self, query: str, query_embedding: Sequence[float], limit: int,
        scope: Optional[ChatScope] = None,
        embedding_index_id: str = "default-openai", dimensions: int = 1536,
    ) -> List[RetrievedChunk]:
        self.ensure_schema()
        if not 1 <= dimensions <= 4000:
            raise ValueError("HNSW halfvec dimensions must be between 1 and 4000.")
        try:
            with self._connect() as connection:
                vector_rows = connection.execute(
                    self._vector_search_sql(embedding_index_id, dimensions),
                    self._vector_parameters(query_embedding, scope),
                ).fetchall()
                text_rows = connection.execute(
                    self._fulltext_sql(), self._fulltext_parameters(query, scope),
                ).fetchall()
                text_candidates = [self._expand_text_hit(connection, row) for row in text_rows]
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid search failed.") from error
        if not vector_rows and not text_candidates:
            return []
        return self._fuse_candidates(vector_rows, text_rows, text_candidates, limit)

    @staticmethod
    def _vector_search_sql(
        embedding_index_id: str = "default-openai", dimensions: int = 1536,
    ) -> str:
        escaped_index_id = embedding_index_id.replace("'", "''")
        return f"""WITH vector_candidates AS MATERIALIZED (
              SELECT id,content,authors,source_message_ids,channel,started_at,metadata,
                     1-(embedding::halfvec({dimensions}) <=> %s) similarity
              FROM rag_chunks
              WHERE embedding_index_id='{escaped_index_id}'
                AND (%s::text IS NULL OR COALESCE(metadata->>'source_type','discord')=%s)
                AND (%s::text IS NULL OR COALESCE(metadata->>'conversation_id',
                                             metadata->>'channel_id')=%s)
              ORDER BY embedding::halfvec({dimensions}) <=> %s LIMIT %s)
            SELECT candidate.id,candidate.content,candidate.authors,candidate.channel,
                   candidate.started_at,candidate.similarity,
                   candidate.source_message_ids,
                   COALESCE(candidate.metadata->>'channel_id',
                            candidate.metadata->>'conversation_id') channel_id,
                   candidate.metadata->>'guild_id' guild_id,
                   COALESCE(candidate.metadata->>'source_type','discord') source_type,
                   COALESCE(candidate.metadata->>'conversation_id',
                            candidate.metadata->>'channel_id') conversation_id,
                   COALESCE((SELECT array_agg(DISTINCT message.content_hash)
                     FROM rag_chunk_messages link
                     JOIN source_messages message ON message.external_id=link.message_id
                     WHERE link.embedding_index_id='{escaped_index_id}'
                       AND link.chunk_id=candidate.id),'{{}}') content_hashes
            FROM vector_candidates candidate ORDER BY candidate.similarity DESC"""

    @staticmethod
    def _fulltext_sql() -> str:
        return """SELECT c.content_hash,
                   ts_rank_cd(c.search_vector, websearch_to_tsquery('simple',%s)) rank,
                   (SELECT external_id FROM source_messages m WHERE m.content_hash=c.content_hash
                    AND (%s::text IS NULL OR m.source_type=%s)
                    AND (%s::text IS NULL OR m.conversation_id=%s)
                    ORDER BY message_order DESC LIMIT 1) latest_id,
                   (SELECT external_id FROM source_messages m WHERE m.content_hash=c.content_hash
                    AND (%s::text IS NULL OR m.source_type=%s)
                    AND (%s::text IS NULL OR m.conversation_id=%s)
                    ORDER BY message_order LIMIT 1) earliest_id
            FROM message_contents c
            WHERE c.search_vector @@ websearch_to_tsquery('simple',%s)
              AND EXISTS (SELECT 1 FROM source_messages m
                          WHERE m.content_hash=c.content_hash
                          AND (%s::text IS NULL OR m.source_type=%s)
                          AND (%s::text IS NULL OR m.conversation_id=%s))
            ORDER BY rank DESC LIMIT %s"""

    @staticmethod
    def _vector_parameters(query_embedding, scope: Optional[ChatScope]) -> tuple:
        source_type = scope.source_type if scope else None
        conversation_id = scope.conversation_id if scope else None
        vector = HalfVector(query_embedding)
        return (
            vector, source_type, source_type, conversation_id, conversation_id,
            vector, 30,
        )

    @staticmethod
    def _fulltext_parameters(query: str, scope: Optional[ChatScope]) -> tuple:
        source_type = scope.source_type if scope else None
        conversation_id = scope.conversation_id if scope else None
        return (
            query, source_type, source_type, conversation_id, conversation_id,
            source_type, source_type, conversation_id, conversation_id, query,
            source_type, source_type, conversation_id, conversation_id, 30,
        )

    def _expand_text_hit(self, connection, row) -> dict:
        anchor_ids = list(dict.fromkeys(anchor for anchor in (row[2], row[3]) if anchor))
        contexts = [self._neighbor_context(connection, anchor) for anchor in anchor_ids]
        context = max(contexts, key=lambda item: len(item["content"]), default=None)
        return {"hash": row[0], "rank": float(row[1]), "context": context}

    @staticmethod
    def _neighbor_context(connection, anchor_id: str) -> dict:
        rows = connection.execute(
            """WITH anchor AS (
                 SELECT source_type,conversation_id,message_order,sent_at
                 FROM source_messages WHERE external_id=%s),
               nearby AS (
                 (SELECT m.*,c.content FROM source_messages m
                  JOIN message_contents c USING(content_hash),anchor a
                  WHERE m.source_type=a.source_type
                    AND m.conversation_id=a.conversation_id
                    AND m.message_order<=a.message_order
                  ORDER BY m.message_order DESC LIMIT 5)
                 UNION
                 (SELECT m.*,c.content FROM source_messages m
                  JOIN message_contents c USING(content_hash),anchor a
                  WHERE m.source_type=a.source_type
                    AND m.conversation_id=a.conversation_id
                    AND m.message_order>a.message_order
                  ORDER BY m.message_order LIMIT 4))
               SELECT author,content,sent_at,COALESCE(conversation_label,channel),
                      external_id,channel_id,guild_id,source_type,conversation_id
               FROM nearby
               ORDER BY message_order LIMIT 12""", (anchor_id,),
        ).fetchall()
        if not rows:
            return {"content": "", "authors": [], "channel": None, "started_at": None}
        filtered = PostgresHybridRetrieval.apply_time_gap(rows, anchor_id)
        content = "\n".join(
            f"[{row[2].isoformat() if row[2] else 'unknown-time'}] {row[0]}: {row[1]}"
            for row in filtered
        )
        return {
            "content": content, "authors": list(dict.fromkeys(row[0] for row in filtered)),
            "channel": filtered[0][3], "started_at": filtered[0][2],
            "source_message_ids": [row[4] for row in filtered],
            "channel_id": filtered[0][5], "guild_id": filtered[0][6],
            "source_type": filtered[0][7], "conversation_id": filtered[0][8],
        }

    @staticmethod
    def apply_time_gap(rows: list, anchor_id: str) -> list:
        if len(rows) < 2:
            return rows
        anchor_index = next(
            (index for index, row in enumerate(rows) if row[4] == anchor_id), None,
        )
        if anchor_index is None:
            return []
        start_index = anchor_index
        while start_index > 0 and not PostgresHybridRetrieval._has_time_gap(
            rows[start_index - 1], rows[start_index],
        ):
            start_index -= 1
        end_index = anchor_index
        while end_index + 1 < len(rows) and not PostgresHybridRetrieval._has_time_gap(
            rows[end_index], rows[end_index + 1],
        ):
            end_index += 1
        return rows[start_index:end_index + 1]

    @staticmethod
    def _has_time_gap(left_row: tuple, right_row: tuple) -> bool:
        if not left_row[2] or not right_row[2]:
            return False
        return abs((right_row[2] - left_row[2]).total_seconds()) > 1200

    def _fuse_candidates(self, vector_rows, text_rows, text_candidates, limit):
        text_rank = {row[0]: index for index, row in enumerate(text_rows, start=1)}
        candidates = []
        matched_hashes = set()
        for rank, row in enumerate(vector_rows, start=1):
            score = 1 / (60 + rank)
            matching = [text_rank[value] for value in row[11] if value in text_rank]
            if matching:
                score += 1 / (60 + min(matching))
                matched_hashes.update(value for value in row[11] if value in text_rank)
            candidates.append((score * self._recency_multiplier(row[4]), self._vector_chunk(row)))
        for rank, item in enumerate(text_candidates, start=1):
            if item["hash"] in matched_hashes or not item["context"]:
                continue
            context = item["context"]
            score = (1 / (60 + rank)) * self._recency_multiplier(context["started_at"])
            candidates.append((score, RetrievedChunk(
                content=context["content"], authors=context["authors"], channel=context["channel"],
                started_at=context["started_at"], similarity_score=score,
                source_message_ids=context["source_message_ids"],
                channel_id=context["channel_id"], guild_id=context["guild_id"],
                source_type=context["source_type"],
                conversation_id=context["conversation_id"],
                score_kind="rrf",
            )))
        candidates.sort(key=lambda item: item[0], reverse=True)
        return [self._with_score(chunk, score) for score, chunk in candidates[:limit]]

    @staticmethod
    def _vector_chunk(row) -> RetrievedChunk:
        return RetrievedChunk(
            content=row[1], authors=row[2], channel=row[3], started_at=row[4],
            similarity_score=float(row[5]), source_message_ids=row[6],
            channel_id=row[7], guild_id=row[8],
            source_type=row[9], conversation_id=row[10],
            chunk_id=row[0], score_kind="rrf",
        )

    @staticmethod
    def _with_score(chunk: RetrievedChunk, score: float) -> RetrievedChunk:
        return RetrievedChunk(
            content=chunk.content, authors=chunk.authors, channel=chunk.channel,
            started_at=chunk.started_at, similarity_score=float(score),
            source_message_ids=chunk.source_message_ids,
            channel_id=chunk.channel_id, guild_id=chunk.guild_id,
            source_type=chunk.source_type, conversation_id=chunk.conversation_id,
            chunk_id=chunk.chunk_id, score_kind="rrf",
        )

    @staticmethod
    def _recency_multiplier(timestamp: datetime) -> float:
        if not timestamp:
            return 1.0
        age_days = max(0, (datetime.now(timezone.utc) - timestamp).total_seconds() / 86400)
        return 1 + 0.1 * math.exp(-math.log(2) * age_days / 1095)

    def _connect(self):
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection
