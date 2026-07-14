from typing import Optional

from pgvector import HalfVector

from backend.archive_time import ArchiveTimeRange
from backend.chat_models import ChatScope


def vector_search_sql(
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
            AND (%s::timestamptz IS NULL OR COALESCE(ended_at,started_at)>=%s)
            AND (%s::timestamptz IS NULL OR started_at<%s)
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


def fulltext_sql() -> str:
    return """SELECT c.content_hash,
               ts_rank_cd(c.search_vector, websearch_to_tsquery('simple',%s)) rank,
               (SELECT external_id FROM source_messages m WHERE m.content_hash=c.content_hash
                AND (%s::text IS NULL OR m.source_type=%s)
                AND (%s::text IS NULL OR m.conversation_id=%s)
                AND (%s::timestamptz IS NULL OR m.sent_at>=%s)
                AND (%s::timestamptz IS NULL OR m.sent_at<%s)
                ORDER BY message_order DESC LIMIT 1) latest_id,
               (SELECT external_id FROM source_messages m WHERE m.content_hash=c.content_hash
                AND (%s::text IS NULL OR m.source_type=%s)
                AND (%s::text IS NULL OR m.conversation_id=%s)
                AND (%s::timestamptz IS NULL OR m.sent_at>=%s)
                AND (%s::timestamptz IS NULL OR m.sent_at<%s)
                ORDER BY message_order LIMIT 1) earliest_id
        FROM message_contents c
        WHERE c.search_vector @@ websearch_to_tsquery('simple',%s)
          AND EXISTS (SELECT 1 FROM source_messages m
                      WHERE m.content_hash=c.content_hash
                      AND (%s::text IS NULL OR m.source_type=%s)
                      AND (%s::text IS NULL OR m.conversation_id=%s)
                      AND (%s::timestamptz IS NULL OR m.sent_at>=%s)
                      AND (%s::timestamptz IS NULL OR m.sent_at<%s))
        ORDER BY rank DESC LIMIT %s"""


def vector_parameters(
    query_embedding, scope: Optional[ChatScope],
    time_range: Optional[ArchiveTimeRange] = None,
) -> tuple:
    source_type = scope.source_type if scope else None
    conversation_id = scope.conversation_id if scope else None
    start_at = time_range.start_at if time_range else None
    end_at = time_range.end_at if time_range else None
    vector = HalfVector(query_embedding)
    return (
        vector, source_type, source_type, conversation_id, conversation_id,
        start_at, start_at, end_at, end_at, vector, 32,
    )


def fulltext_parameters(
    query: str, scope: Optional[ChatScope],
    time_range: Optional[ArchiveTimeRange] = None,
) -> tuple:
    source_type = scope.source_type if scope else None
    conversation_id = scope.conversation_id if scope else None
    start_at = time_range.start_at if time_range else None
    end_at = time_range.end_at if time_range else None
    filters = (
        source_type, source_type, conversation_id, conversation_id,
        start_at, start_at, end_at, end_at,
    )
    return query, *filters, *filters, query, *filters, 32


def expand_text_hit(connection, row, time_range) -> dict:
    anchor_ids = list(dict.fromkeys(anchor for anchor in (row[2], row[3]) if anchor))
    contexts = [neighbor_context(connection, anchor, time_range) for anchor in anchor_ids]
    context = max(contexts, key=lambda item: len(item["content"]), default=None)
    return {"hash": row[0], "rank": float(row[1]), "context": context}


def neighbor_context(connection, anchor_id: str, time_range=None) -> dict:
    rows = connection.execute(neighbor_query(), (
        time_range.start_at if time_range else None,
        time_range.end_at if time_range else None,
        anchor_id,
    )).fetchall()
    if not rows:
        return {"content": "", "authors": [], "channel": None, "started_at": None}
    filtered = apply_time_gap(rows, anchor_id)
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


def neighbor_query() -> str:
    return """WITH anchor AS (
             SELECT source_type,conversation_id,message_order,sent_at,
                    %s::timestamptz range_start,%s::timestamptz range_end
             FROM source_messages WHERE external_id=%s),
           nearby AS (
             (SELECT m.*,c.content FROM source_messages m
              JOIN message_contents c USING(content_hash),anchor a
              WHERE m.source_type=a.source_type
                AND m.conversation_id=a.conversation_id
                AND m.message_order<=a.message_order
                AND (a.range_start IS NULL OR m.sent_at>=a.range_start)
                AND (a.range_end IS NULL OR m.sent_at<a.range_end)
              ORDER BY m.message_order DESC LIMIT 5)
             UNION
             (SELECT m.*,c.content FROM source_messages m
              JOIN message_contents c USING(content_hash),anchor a
              WHERE m.source_type=a.source_type
                AND m.conversation_id=a.conversation_id
                AND m.message_order>a.message_order
                AND (a.range_start IS NULL OR m.sent_at>=a.range_start)
                AND (a.range_end IS NULL OR m.sent_at<a.range_end)
              ORDER BY m.message_order LIMIT 4))
           SELECT author,content,sent_at,COALESCE(conversation_label,channel),
                  external_id,channel_id,guild_id,source_type,conversation_id
           FROM nearby
           ORDER BY message_order LIMIT 12"""


def apply_time_gap(rows: list, anchor_id: str) -> list:
    if len(rows) < 2:
        return rows
    anchor_index = next(
        (index for index, row in enumerate(rows) if row[4] == anchor_id), None,
    )
    if anchor_index is None:
        return []
    start_index = anchor_index
    while start_index > 0 and not has_time_gap(rows[start_index - 1], rows[start_index]):
        start_index -= 1
    end_index = anchor_index
    while end_index + 1 < len(rows) and not has_time_gap(
        rows[end_index], rows[end_index + 1],
    ):
        end_index += 1
    return rows[start_index:end_index + 1]


def has_time_gap(left_row: tuple, right_row: tuple) -> bool:
    if not left_row[2] or not right_row[2]:
        return False
    return abs((right_row[2] - left_row[2]).total_seconds()) > 1200
