import hashlib
from datetime import timedelta
from typing import List, Optional

from backend.vector_models import ConversationChunk, NormalizedMessage


class ConversationAwareChunker:
    def __init__(self, max_characters: int = 1800, max_gap_minutes: int = 20) -> None:
        self.max_characters = max_characters
        self.max_gap = timedelta(minutes=max_gap_minutes)

    def chunk(self, messages: List[NormalizedMessage]) -> List[ConversationChunk]:
        chunks: List[ConversationChunk] = []
        current: List[NormalizedMessage] = []
        for message in messages:
            if current and self._must_split(current, message):
                chunks.extend(self._build_chunks(current))
                current = []
            current.append(message)
        if current:
            chunks.extend(self._build_chunks(current))
        return chunks

    def _must_split(self, current: List[NormalizedMessage], message: NormalizedMessage) -> bool:
        previous = current[-1]
        if previous.channel != message.channel:
            return True
        if previous.channel_id != message.channel_id:
            return True
        if previous.timestamp and message.timestamp:
            if message.timestamp - previous.timestamp > self.max_gap:
                return True
        projected = len(self._render_messages(current + [message]))
        return projected > self.max_characters

    def _build_chunks(self, messages: List[NormalizedMessage]) -> List[ConversationChunk]:
        rendered = self._render_messages(messages)
        parts = self._split_long_text(rendered)
        return [self._build_chunk(messages, part, index) for index, part in enumerate(parts)]

    def _build_chunk(
        self, messages: List[NormalizedMessage], content: str, part_index: int
    ) -> ConversationChunk:
        source_ids = [message.external_id for message in messages]
        identity = "|".join(source_ids + [str(part_index), content])
        chunk_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        timestamps = [message.timestamp for message in messages if message.timestamp]
        return ConversationChunk(
            chunk_id=chunk_id,
            content=content,
            authors=list(dict.fromkeys(message.author for message in messages)),
            source_message_ids=source_ids,
            channel=messages[0].channel,
            started_at=min(timestamps) if timestamps else None,
            ended_at=max(timestamps) if timestamps else None,
            metadata={
                "part_index": part_index,
                "message_count": len(messages),
                "channel_id": messages[0].channel_id,
                "guild_id": messages[0].guild_id,
            },
        )

    def _render_messages(self, messages: List[NormalizedMessage]) -> str:
        return "\n".join(self._render_message(message) for message in messages)

    @staticmethod
    def _render_message(message: NormalizedMessage) -> str:
        timestamp = message.timestamp.isoformat() if message.timestamp else "unknown-time"
        return f"[{timestamp}] {message.author}: {message.content}"

    def _split_long_text(self, content: str) -> List[str]:
        return [
            content[start : start + self.max_characters]
            for start in range(0, len(content), self.max_characters)
        ]
