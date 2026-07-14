from typing import List, Optional

from backend.chat_models import ChatSource, ChatSourceChunk
from backend.source_context import SourceContextProjector
from backend.vector_models import RetrievedChunk


def project_chat_sources(
    chunks: List[RetrievedChunk], projector: Optional[SourceContextProjector],
) -> List[ChatSource]:
    if projector:
        return projector.project_chunks(chunks)
    sources = [_chunk_source(chunk) for chunk in chunks]
    return SourceContextProjector.normalize_match_scores(sources)


def _chunk_source(chunk: RetrievedChunk) -> ChatSource:
    score_kind = chunk.score_kind if chunk.score_kind in {"rrf", "cosine"} else "unknown"
    return ChatSource(
        author=", ".join(chunk.authors), content=chunk.content,
        timestamp=chunk.started_at, channel=chunk.channel,
        similarity_score=chunk.similarity_score, score_kind=score_kind,
        chunk=ChatSourceChunk(
            chunk_id=chunk.chunk_id, content=chunk.content,
            source_message_ids=chunk.source_message_ids, origin="retrieved",
        ),
        source_message_ids=chunk.source_message_ids,
        channel_id=chunk.channel_id, guild_id=chunk.guild_id,
        source_type=chunk.source_type, conversation_id=chunk.conversation_id,
    )
