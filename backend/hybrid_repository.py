import math
import threading
from datetime import datetime, timezone
from typing import Iterable, List, Sequence

import numpy as np
import psycopg
from pgvector import HalfVector
from pgvector.psycopg import register_vector
from psycopg.types.json import Jsonb

from backend.openai_gateway import ExternalIntegrationError
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class PostgresHybridRepository:
    def __init__(self, database_dsn: str, dimensions: int) -> None:
        self.database_dsn = database_dsn
        self.dimensions = dimensions
        self._initialized = False
        self._lock = threading.Lock()

    def upsert_chunks(self, chunks: Iterable[EmbeddedChunk]) -> int:
        chunk_list = list(chunks)
        if not chunk_list:
            return 0
        self.ensure_schema()
        try:
            with self._connect() as connection:
                with connection.cursor() as cursor:
                    cursor.executemany(self._upsert_sql(), [self._to_row(item) for item in chunk_list])
                    for item in chunk_list:
                        self._replace_chunk_links(cursor, item)
            return len(chunk_list)
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL halfvec write failed.") from error

    def search_hybrid(
        self, query: str, query_embedding: Sequence[float], limit: int = 8
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

    def has_indexed_chunks(self) -> bool:
        self.ensure_schema()
        with self._connect() as connection:
            return bool(connection.execute("SELECT EXISTS(SELECT 1 FROM rag_chunks)").fetchone()[0])

    def delete_chunks_affected_by_session(self, session_id: str) -> int:
        self.ensure_schema()
        with self._connect() as connection:
            result = connection.execute(
                """DELETE FROM rag_chunks WHERE id IN (
                     SELECT DISTINCT cm.chunk_id FROM rag_chunk_messages cm
                     JOIN ingestion_session_messages sm ON sm.message_id=cm.message_id
                     WHERE sm.session_id=%s)""", (session_id,),
            )
        return result.rowcount

    def ensure_schema(self) -> None:
        if self._initialized:
            return
        with self._lock:
            if self._initialized:
                return
            self._create_schema()
            self._initialized = True

    def _create_schema(self) -> None:
        try:
            with psycopg.connect(self.database_dsn, autocommit=True) as connection:
                connection.execute("CREATE EXTENSION IF NOT EXISTS vector")
                register_vector(connection)
                connection.execute(self._create_chunks_sql())
                connection.execute(self._create_links_sql())
                connection.execute(self._create_index_sql())
        except psycopg.Error as error:
            raise ExternalIntegrationError("PostgreSQL hybrid schema initialization failed.") from error

    def _create_chunks_sql(self) -> str:
        return f"""CREATE TABLE IF NOT EXISTS rag_chunks (
            id TEXT PRIMARY KEY, content TEXT NOT NULL, authors TEXT[] NOT NULL,
            source_message_ids TEXT[] NOT NULL, channel TEXT, started_at TIMESTAMPTZ,
            ended_at TIMESTAMPTZ, embedding_model TEXT NOT NULL,
            embedding halfvec({self.dimensions}) NOT NULL, metadata JSONB NOT NULL DEFAULT '{{}}',
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())"""

    @staticmethod
    def _create_links_sql() -> str:
        return """CREATE TABLE IF NOT EXISTS rag_chunk_messages (
            chunk_id TEXT REFERENCES rag_chunks(id) ON DELETE CASCADE,
            message_id TEXT REFERENCES discord_messages(external_id) ON DELETE CASCADE,
            position INTEGER NOT NULL, PRIMARY KEY(chunk_id,message_id))"""

    @staticmethod
    def _create_index_sql() -> str:
        return """CREATE INDEX IF NOT EXISTS rag_chunks_embedding_hnsw
            ON rag_chunks USING hnsw (embedding halfvec_cosine_ops);
            CREATE INDEX IF NOT EXISTS rag_chunk_messages_message
            ON rag_chunk_messages(message_id)"""

    @staticmethod
    def _upsert_sql() -> str:
        return """INSERT INTO rag_chunks
            (id,content,authors,source_message_ids,channel,started_at,ended_at,
             embedding_model,embedding,metadata)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(id) DO UPDATE SET content=EXCLUDED.content,
              authors=EXCLUDED.authors, source_message_ids=EXCLUDED.source_message_ids,
              embedding_model=EXCLUDED.embedding_model, embedding=EXCLUDED.embedding,
              metadata=EXCLUDED.metadata, updated_at=NOW()"""

    @staticmethod
    def _replace_chunk_links(cursor, item: EmbeddedChunk) -> None:
        cursor.execute("DELETE FROM rag_chunk_messages WHERE chunk_id=%s", (item.chunk.chunk_id,))
        cursor.executemany(
            """INSERT INTO rag_chunk_messages(chunk_id,message_id,position)
               VALUES (%s,%s,%s) ON CONFLICT DO NOTHING""",
            [(item.chunk.chunk_id, message_id, index)
             for index, message_id in enumerate(item.chunk.source_message_ids)],
        )

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
        filtered = PostgresHybridRepository._apply_time_gap(rows)
        content = "\n".join(
            f"[{row[2].isoformat() if row[2] else 'unknown-time'}] {row[0]}: {row[1]}"
            for row in filtered
        )
        return {
            "content": content, "authors": list(dict.fromkeys(row[0] for row in filtered)),
            "channel": filtered[0][3], "started_at": filtered[0][2],
        }

    @staticmethod
    def _apply_time_gap(rows: list) -> list:
        if len(rows) < 2:
            return rows
        result = [rows[0]]
        for row in rows[1:]:
            previous_time, current_time = result[-1][2], row[2]
            if previous_time and current_time:
                if abs((current_time - previous_time).total_seconds()) > 1200:
                    continue
            result.append(row)
        return result

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

    @staticmethod
    def _to_row(item: EmbeddedChunk) -> tuple:
        chunk = item.chunk
        return (
            chunk.chunk_id, chunk.content, chunk.authors, chunk.source_message_ids,
            chunk.channel, chunk.started_at, chunk.ended_at, item.embedding_model,
            HalfVector(np.asarray(item.embedding, dtype=np.float16)), Jsonb(chunk.metadata),
        )

    def _connect(self):
        connection = psycopg.connect(self.database_dsn)
        register_vector(connection)
        return connection
