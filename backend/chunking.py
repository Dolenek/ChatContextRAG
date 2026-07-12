import hashlib
import re
from datetime import datetime, timedelta
from typing import Iterable, Iterator, List, Optional

from backend.vector_models import ConversationChunk, NormalizedMessage


class ConversationAwareChunker:
    def __init__(
        self, max_characters: int = 1800, max_gap_minutes: int = 20,
        overlap_characters: int = 160,
    ) -> None:
        if max_characters < 80:
            raise ValueError("max_characters must be at least 80")
        self.max_characters = max_characters
        self.max_gap = timedelta(minutes=max_gap_minutes)
        self.overlap_characters = min(overlap_characters, max_characters // 4)

    def chunk(self, messages: List[NormalizedMessage]) -> List[ConversationChunk]:
        return list(self.chunk_stream(messages))

    def chunk_stream(
        self, messages: Iterable[NormalizedMessage]
    ) -> Iterator[ConversationChunk]:
        current: List[NormalizedMessage] = []
        for message in messages:
            if current and self._must_split(current, message):
                yield from self._build_chunks(current)
                current = []
            current.append(message)
        if current:
            yield from self._build_chunks(current)

    def _must_split(self, current: List[NormalizedMessage], message: NormalizedMessage) -> bool:
        previous = current[-1]
        if previous.source_type != message.source_type:
            return True
        if self._conversation_id(previous) != self._conversation_id(message):
            return True
        if previous.channel != message.channel:
            return True
        if previous.channel_id != message.channel_id:
            return True
        previous_timestamp = self._latest_timestamp(previous)
        message_timestamp = self._earliest_timestamp(message)
        if previous_timestamp and message_timestamp:
            if message_timestamp - previous_timestamp > self.max_gap:
                return True
        projected = len(self._render_messages(current + [message]))
        return projected > self.max_characters

    @staticmethod
    def _latest_timestamp(message: NormalizedMessage) -> Optional[datetime]:
        timestamps = (message.timestamp,) + message.related_timestamps
        return max((timestamp for timestamp in timestamps if timestamp), default=None)

    @staticmethod
    def _earliest_timestamp(message: NormalizedMessage) -> Optional[datetime]:
        timestamps = (message.timestamp,) + message.related_timestamps
        return min((timestamp for timestamp in timestamps if timestamp), default=None)

    def _build_chunks(self, messages: List[NormalizedMessage]) -> List[ConversationChunk]:
        rendered = self._render_messages(messages)
        parts = self._split_long_text(rendered)
        return [self._build_chunk(messages, part, index) for index, part in enumerate(parts)]

    def _build_chunk(
        self, messages: List[NormalizedMessage], content: str, part_index: int
    ) -> ConversationChunk:
        source_ids = [
            source_id for message in messages
            for source_id in (message.external_id, *message.related_external_ids)
        ]
        identity = "|".join([
            messages[0].source_type, self._conversation_id(messages[0]) or "",
            *source_ids, str(part_index), content,
        ])
        chunk_id = hashlib.sha256(identity.encode("utf-8")).hexdigest()
        timestamps = [
            timestamp for message in messages
            for timestamp in ((message.timestamp,) + message.related_timestamps)
            if timestamp
        ]
        return ConversationChunk(
            chunk_id=chunk_id,
            content=content,
            authors=list(dict.fromkeys(message.author for message in messages)),
            source_message_ids=source_ids,
            channel=messages[0].conversation_label or messages[0].channel,
            started_at=min(timestamps) if timestamps else None,
            ended_at=max(timestamps) if timestamps else None,
            metadata={
                **messages[0].source_metadata,
                "part_index": part_index,
                "message_count": len(messages),
                "source_type": messages[0].source_type,
                "conversation_id": self._conversation_id(messages[0]),
                "conversation_label": messages[0].conversation_label or messages[0].channel,
                "container_id": messages[0].container_id or messages[0].guild_id,
                "container_label": messages[0].container_label,
                "channel_id": messages[0].channel_id,
                "guild_id": messages[0].guild_id,
            },
        )

    @staticmethod
    def _conversation_id(message: NormalizedMessage) -> Optional[str]:
        return message.conversation_id or message.channel_id

    def _render_messages(self, messages: List[NormalizedMessage]) -> str:
        return "\n".join(self._render_message(message) for message in messages)

    @staticmethod
    def _render_message(message: NormalizedMessage) -> str:
        timestamp = message.timestamp.isoformat() if message.timestamp else "unknown-time"
        return f"[{timestamp}] {message.author}: {message.content}"

    def _split_long_text(self, content: str) -> List[str]:
        if len(content) <= self.max_characters:
            return [content]
        parts = []
        start = 0
        while start < len(content):
            prefix = "" if not parts else self._continuation_prefix(content, start)
            available = self.max_characters - len(prefix)
            proposed_end = min(len(content), start + available)
            end = self._semantic_boundary(content, start, proposed_end)
            segment = content[start:end].strip()
            parts.append(f"{prefix}{segment}")
            if end >= len(content):
                break
            start = self._overlap_start(content, start, end)
        return parts

    @staticmethod
    def _semantic_boundary(content: str, start: int, proposed_end: int) -> int:
        if proposed_end >= len(content):
            return proposed_end
        minimum = start + max(1, (proposed_end - start) // 2)
        for separator in ("\n\n", "\n", ". ", " "):
            boundary = content.rfind(separator, minimum, proposed_end)
            if boundary >= minimum:
                return boundary + len(separator)
        return proposed_end

    def _overlap_start(self, content: str, previous_start: int, end: int) -> int:
        candidate = max(previous_start + 1, end - self.overlap_characters)
        word_boundary = content.find(" ", candidate, end)
        return word_boundary + 1 if word_boundary >= candidate else candidate

    def _continuation_prefix(self, content: str, start: int) -> str:
        header_matches = list(re.finditer(r"(?m)^\[[^\]]+\] [^\n]+?: ", content[:start]))
        label = header_matches[-1].group(0).strip() if header_matches else "zprávy"
        prefix = f"[Pokračování] {label}\n"
        if len(prefix) > self.max_characters // 3:
            return "[Pokračování]\n"
        return prefix
