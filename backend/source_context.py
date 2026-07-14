from typing import List, Protocol, Sequence

from backend.models import ChatSource
from backend.vector_models import NormalizedMessage, RetrievedChunk


class SourceMessageReader(Protocol):
    def load_messages_by_ids(
        self, message_ids: Sequence[str],
    ) -> List[NormalizedMessage]: ...


class SourceContextProjector:
    """Projects ranked RAG evidence into source-message UI records."""

    def __init__(self, message_reader: SourceMessageReader) -> None:
        self.message_reader = message_reader

    def project_chunks(self, chunks: Sequence[RetrievedChunk]) -> List[ChatSource]:
        groups = [
            (chunk.source_message_ids, chunk.similarity_score, self._chunk_fallback(chunk))
            for chunk in chunks
        ]
        return self._expand_groups(groups)

    def expand_sources(self, sources: Sequence[ChatSource]) -> List[ChatSource]:
        groups = [
            (source.source_message_ids, source.similarity_score, source)
            for source in sources
        ]
        return self._expand_groups(groups)

    def _expand_groups(self, groups) -> List[ChatSource]:
        message_ids = list(dict.fromkeys(
            message_id for source_ids, _score, _fallback in groups
            for message_id in source_ids
        ))
        messages = {
            message.external_id: message
            for message in self.message_reader.load_messages_by_ids(message_ids)
        }
        scores = self._highest_scores(groups)
        return self._ordered_sources(groups, messages, scores)

    @staticmethod
    def _highest_scores(groups) -> dict:
        scores = {}
        for source_ids, score, _fallback in groups:
            for message_id in source_ids:
                scores[message_id] = max(score, scores.get(message_id, float("-inf")))
        return scores

    def _ordered_sources(self, groups, messages: dict, scores: dict) -> List[ChatSource]:
        projected = []
        seen_ids = set()
        for source_ids, _score, fallback in groups:
            missing_message = False
            for message_id in source_ids:
                if message_id in seen_ids:
                    continue
                seen_ids.add(message_id)
                message = messages.get(message_id)
                if message:
                    projected.append(self._message_source(message, scores[message_id]))
                else:
                    missing_message = True
            if missing_message or (not source_ids and fallback):
                projected.append(fallback)
        return projected

    @staticmethod
    def _message_source(message: NormalizedMessage, score: float) -> ChatSource:
        return ChatSource(
            author=message.author, content=message.content,
            timestamp=message.timestamp,
            channel=message.conversation_label or message.channel,
            similarity_score=score, source_message_ids=[message.external_id],
            channel_id=message.channel_id, guild_id=message.guild_id,
            source_type=message.source_type,
            conversation_id=message.conversation_id,
        )

    @staticmethod
    def _chunk_fallback(chunk: RetrievedChunk) -> ChatSource:
        return ChatSource(
            author=", ".join(chunk.authors), content=chunk.content,
            timestamp=chunk.started_at, channel=chunk.channel,
            similarity_score=chunk.similarity_score,
            source_message_ids=chunk.source_message_ids,
            channel_id=chunk.channel_id, guild_id=chunk.guild_id,
            source_type=chunk.source_type,
            conversation_id=chunk.conversation_id,
        )
