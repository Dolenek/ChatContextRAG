from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol, Sequence

from backend.models import ChatSource, ChatSourceChunk
from backend.vector_models import NormalizedMessage, RetrievedChunk


class SourceMessageReader(Protocol):
    def load_messages_by_ids(
        self, message_ids: Sequence[str],
    ) -> List[NormalizedMessage]: ...

    def load_chunk_contexts_by_ids(
        self, message_ids: Sequence[str],
    ) -> Dict[str, ChatSourceChunk]: ...


@dataclass(frozen=True)
class ProjectionGroup:
    message_ids: Sequence[str]
    score: float
    score_kind: str
    fallback: ChatSource
    chunk: Optional[ChatSourceChunk]


class SourceContextProjector:
    """Projects ranked RAG evidence into source-message UI records."""

    def __init__(self, message_reader: SourceMessageReader) -> None:
        self.message_reader = message_reader

    def project_chunks(self, chunks: Sequence[RetrievedChunk]) -> List[ChatSource]:
        groups = [self._retrieved_group(chunk) for chunk in chunks]
        return self._expand_groups(groups)

    def expand_sources(self, sources: Sequence[ChatSource]) -> List[ChatSource]:
        groups = [self._stored_group(source) for source in sources]
        return self._expand_groups(groups)

    def _expand_groups(self, groups: Sequence[ProjectionGroup]) -> List[ChatSource]:
        message_ids = self._ordered_message_ids(groups)
        messages = {
            message.external_id: message
            for message in self.message_reader.load_messages_by_ids(message_ids)
        }
        reconstructed = self._load_reconstructed_chunks(groups, message_ids)
        best_groups = self._best_groups(groups)
        projected = self._ordered_sources(groups, messages, best_groups, reconstructed)
        return self.normalize_match_scores(projected)

    def _load_reconstructed_chunks(
        self, groups: Sequence[ProjectionGroup], message_ids: Sequence[str],
    ) -> Dict[str, ChatSourceChunk]:
        missing_ids = list(dict.fromkeys(
            message_id for group in groups if not group.chunk
            for message_id in group.message_ids
        ))
        loader = getattr(self.message_reader, "load_chunk_contexts_by_ids", None)
        return loader(missing_ids) if loader and missing_ids else {}

    @staticmethod
    def _ordered_message_ids(groups: Sequence[ProjectionGroup]) -> List[str]:
        return list(dict.fromkeys(
            message_id for group in groups for message_id in group.message_ids
        ))

    @staticmethod
    def _best_groups(groups: Sequence[ProjectionGroup]) -> Dict[str, ProjectionGroup]:
        best: Dict[str, ProjectionGroup] = {}
        for group in groups:
            for message_id in group.message_ids:
                current = best.get(message_id)
                if not current or group.score > current.score:
                    best[message_id] = group
        return best

    def _ordered_sources(self, groups, messages, best_groups, reconstructed):
        projected, seen_ids, fallback_groups = [], set(), set()
        for group in groups:
            for message_id in group.message_ids:
                if message_id in seen_ids:
                    continue
                seen_ids.add(message_id)
                message = messages.get(message_id)
                if message:
                    selected = best_groups[message_id]
                    chunk = selected.chunk or reconstructed.get(message_id)
                    projected.append(self._message_source(message, selected, chunk))
                else:
                    selected = best_groups[message_id]
                    if id(selected) not in fallback_groups:
                        projected.append(self._fallback_source(selected))
                        fallback_groups.add(id(selected))
            if not group.message_ids:
                projected.append(self._fallback_source(group))
        return projected

    @staticmethod
    def _message_source(message, group, chunk) -> ChatSource:
        return ChatSource(
            author=message.author, content=message.content,
            timestamp=message.timestamp,
            channel=message.conversation_label or message.channel,
            similarity_score=group.score, score_kind=group.score_kind,
            source_message_ids=[message.external_id], chunk=chunk,
            channel_id=message.channel_id, guild_id=message.guild_id,
            source_type=message.source_type,
            conversation_id=message.conversation_id,
        )

    @staticmethod
    def _fallback_source(group: ProjectionGroup) -> ChatSource:
        return group.fallback.model_copy(update={
            "similarity_score": group.score, "score_kind": group.score_kind,
            "chunk": group.chunk,
        })

    @staticmethod
    def _retrieved_group(chunk: RetrievedChunk) -> ProjectionGroup:
        context = ChatSourceChunk(
            chunk_id=chunk.chunk_id, content=chunk.content,
            source_message_ids=chunk.source_message_ids, origin="retrieved",
        )
        fallback = SourceContextProjector._chunk_fallback(chunk, context)
        return ProjectionGroup(
            chunk.source_message_ids, chunk.similarity_score,
            SourceContextProjector._score_kind(chunk.score_kind), fallback, context,
        )

    @staticmethod
    def _stored_group(source: ChatSource) -> ProjectionGroup:
        chunk = source.chunk
        if not chunk and len(source.source_message_ids) > 1:
            chunk = ChatSourceChunk(
                content=source.content, source_message_ids=source.source_message_ids,
                origin="retrieved",
            )
        return ProjectionGroup(
            source.source_message_ids, source.similarity_score,
            SourceContextProjector._score_kind(source.score_kind), source, chunk,
        )

    @staticmethod
    def _chunk_fallback(chunk, context) -> ChatSource:
        return ChatSource(
            author=", ".join(chunk.authors), content=chunk.content,
            timestamp=chunk.started_at, channel=chunk.channel,
            similarity_score=chunk.similarity_score,
            score_kind=SourceContextProjector._score_kind(chunk.score_kind),
            chunk=context, source_message_ids=chunk.source_message_ids,
            channel_id=chunk.channel_id, guild_id=chunk.guild_id,
            source_type=chunk.source_type, conversation_id=chunk.conversation_id,
        )

    @staticmethod
    def normalize_match_scores(sources: Sequence[ChatSource]) -> List[ChatSource]:
        highest = max((source.similarity_score for source in sources), default=0.0)
        highest = highest if highest > 0 else 0.0
        return [source.model_copy(update={
            "match_score": max(0.0, source.similarity_score) / highest if highest else 0.0,
        }) for source in sources]

    @staticmethod
    def _score_kind(value: str) -> str:
        return value if value in {"rrf", "cosine"} else "unknown"
