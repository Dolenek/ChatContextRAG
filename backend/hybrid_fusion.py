import math
from datetime import datetime, timezone

from backend.vector_models import RetrievedChunk


def fuse_candidates(vector_rows, text_rows, text_candidates, limit, time_range=None):
    text_rank = {row[0]: index for index, row in enumerate(text_rows, start=1)}
    candidates = []
    matched_hashes = set()
    for rank, row in enumerate(vector_rows, start=1):
        score = 1 / (60 + rank)
        matching = [text_rank[value] for value in row[11] if value in text_rank]
        if matching:
            score += 1 / (60 + min(matching))
            matched_hashes.update(value for value in row[11] if value in text_rank)
        candidates.append((score * recency_multiplier(row[4]), vector_chunk(row)))
    append_text_candidates(
        candidates, text_candidates, matched_hashes,
    )
    candidates.sort(key=lambda item: item[0], reverse=True)
    selected = temporal_selection(candidates, limit, time_range)
    return [with_score(chunk, score) for score, chunk in selected]


def append_text_candidates(candidates, text_candidates, matched_hashes) -> None:
    for rank, item in enumerate(text_candidates, start=1):
        if item["hash"] in matched_hashes or not item["context"]:
            continue
        context = item["context"]
        score = (1 / (60 + rank)) * recency_multiplier(context["started_at"])
        candidates.append((score, RetrievedChunk(
            content=context["content"], authors=context["authors"],
            channel=context["channel"], started_at=context["started_at"],
            similarity_score=score, source_message_ids=context["source_message_ids"],
            channel_id=context["channel_id"], guild_id=context["guild_id"],
            source_type=context["source_type"], conversation_id=context["conversation_id"],
            score_kind="rrf",
        )))


def temporal_selection(candidates, limit, time_range):
    if limit <= 0:
        return []
    if not time_range or not time_range.start_at or not time_range.end_at:
        return candidates[:limit]
    duration = (time_range.end_at - time_range.start_at).total_seconds()
    if duration <= 0:
        return candidates[:limit]
    bucket_count = min(limit, 8)
    buckets = {}
    for candidate in candidates:
        timestamp = candidate[1].started_at
        if not timestamp:
            continue
        offset = (timestamp - time_range.start_at).total_seconds()
        bucket = min(
            bucket_count - 1, max(0, int(offset / duration * bucket_count)),
        )
        buckets.setdefault(bucket, candidate)
    selected = list(buckets.values())[:limit]
    selected_ids = {id(candidate) for candidate in selected}
    selected.extend(
        candidate for candidate in candidates if id(candidate) not in selected_ids
    )
    return selected[:limit]


def vector_chunk(row) -> RetrievedChunk:
    return RetrievedChunk(
        content=row[1], authors=row[2], channel=row[3], started_at=row[4],
        similarity_score=float(row[5]), source_message_ids=row[6],
        channel_id=row[7], guild_id=row[8], source_type=row[9],
        conversation_id=row[10], chunk_id=row[0], score_kind="rrf",
    )


def with_score(chunk: RetrievedChunk, score: float) -> RetrievedChunk:
    return RetrievedChunk(
        content=chunk.content, authors=chunk.authors, channel=chunk.channel,
        started_at=chunk.started_at, similarity_score=float(score),
        source_message_ids=chunk.source_message_ids, channel_id=chunk.channel_id,
        guild_id=chunk.guild_id, source_type=chunk.source_type,
        conversation_id=chunk.conversation_id, chunk_id=chunk.chunk_id,
        score_kind="rrf",
    )


def recency_multiplier(timestamp: datetime) -> float:
    if not timestamp:
        return 1.0
    age_days = max(0, (datetime.now(timezone.utc) - timestamp).total_seconds() / 86400)
    return 1 + 0.1 * math.exp(-math.log(2) * age_days / 1095)
