import math
from datetime import datetime, timezone
from typing import Callable, List, Sequence

import psycopg
from pgvector import HalfVector
from pgvector.psycopg import register_vector

from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import RetrievedChunk


class PostgresHybridRetrieval:
    def __init__(self, database_dsn: str, ensure_schema: Callable[[], None]) -> None:
        self.database_dsn = database_dsn
        self.ensure_schema = ensure_schema

    def search(
        self, query: str, query_embedding: Sequence[float], limit: int,
    ) -> List[RetrievedChunk]:
        self.ensure_schema()
        try:
            with self._connect() as connection:
                vector_rows = connection.execute(
                    self._vector_search_sql(),
                    (HalfVector(query_embedding), HalfVector(query_embedding), 30),
                ).fetchall()
                text_rows = connection.execute(
                    self._fulltext_sql(), (query, query, 30),
                ).fetchall()
                text_candidates = [self._expand_text_hit(connection, row) for row in text_rows]
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid search failed.") from error
        if not vector_rows and not text_candidates:
            return []
        return self._fuse_candidates(vector_rows, text_rows, text_candidates, limit)

    @staticmethod
    def _vector_search_sql() -> str:
        return """SELECT c.id,c.content,c.authors,c.channel,c.started_at,
                   1-(c.embedding <=> %s) similarity,
                   COALESCE(array_agg(DISTINCT m.content_hash)
                     FILTER (WHERE m.content_hash IS NOT NULL),'{}') content_hashes
            FROM rag_chunks c
            LEFT JOIN rag_chunk_messages cm ON cm.chunk_id=c.id
            LEFT JOIN discord_messages m ON m.external_id=cm.message_id
            GROUP BY c.id ORDER BY c.embedding <=> %s LIMIT %s"""

    @staticmethod
    def _fulltext_sql() -> str:
        return """SELECT c.content_hash,
                   ts_rank_cd(c.search_vector, websearch_to_tsquery('simple',%s)) rank,
                   (SELECT external_id FROM discord_messages m WHERE m.content_hash=c.content_hash
                    ORDER BY sent_at DESC NULLS LAST,message_order DESC LIMIT 1) latest_id,
                   (SELECT external_id FROM discord_messages m WHERE m.content_hash=c.content_hash
                    ORDER BY sent_at NULLS LAST,message_order LIMIT 1) earliest_id
            FROM message_contents c
            WHERE c.search_vector @@ websearch_to_tsquery('simple',%s)
              AND EXISTS (SELECT 1 FROM discord_messages m
                          WHERE m.content_hash=c.content_hash)
            ORDER BY rank DESC LIMIT %s"""

    def _expand_text_hit(self, connection, row) -> dict:
        anchor_ids = list(dict.fromkeys(anchor for anchor in (row[2], row[3]) if anchor))
        contexts = [self._neighbor_context(connection, anchor) for anchor in anchor_ids]
        context = max(contexts, key=lambda item: len(item["content"]), default=None)
        return {"hash": row[0], "rank": float(row[1]), "context": context}

    @staticmethod
    def _neighbor_context(connection, anchor_id: str) -> dict:
        rows = connection.execute(
            """WITH anchor AS (
                 SELECT channel_id,message_order,sent_at FROM discord_messages WHERE external_id=%s),
               nearby AS (
                 (SELECT m.*,c.content FROM discord_messages m JOIN message_contents c USING(content_hash),anchor a
                  WHERE m.channel_id=a.channel_id AND m.message_order<=a.message_order
                  ORDER BY m.message_order DESC LIMIT 5)
                 UNION
                 (SELECT m.*,c.content FROM discord_messages m JOIN message_contents c USING(content_hash),anchor a
                  WHERE m.channel_id=a.channel_id AND m.message_order>a.message_order
                  ORDER BY m.message_order LIMIT 4))
               SELECT author,content,sent_at,channel,external_id FROM nearby
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
            matching = [text_rank[value] for value in row[6] if value in text_rank]
            if matching:
                score += 1 / (60 + min(matching))
                matched_hashes.update(value for value in row[6] if value in text_rank)
            candidates.append((score * self._recency_multiplier(row[4]), self._vector_chunk(row)))
        for rank, item in enumerate(text_candidates, start=1):
            if item["hash"] in matched_hashes or not item["context"]:
                continue
            context = item["context"]
            score = (1 / (60 + rank)) * self._recency_multiplier(context["started_at"])
            candidates.append((score, RetrievedChunk(
                content=context["content"], authors=context["authors"], channel=context["channel"],
                started_at=context["started_at"], similarity_score=score,
            )))
        candidates.sort(key=lambda item: item[0], reverse=True)
        return [self._with_score(chunk, score) for score, chunk in candidates[:limit]]

    @staticmethod
    def _vector_chunk(row) -> RetrievedChunk:
        return RetrievedChunk(
            content=row[1], authors=row[2], channel=row[3], started_at=row[4],
            similarity_score=float(row[5]),
        )

    @staticmethod
    def _with_score(chunk: RetrievedChunk, score: float) -> RetrievedChunk:
        return RetrievedChunk(
            content=chunk.content, authors=chunk.authors, channel=chunk.channel,
            started_at=chunk.started_at, similarity_score=float(score),
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
