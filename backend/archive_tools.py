from datetime import datetime, timezone
from typing import Callable, List, Optional, Protocol, Sequence, Set

from backend.chat_models import ChatScope, ChatSource
from backend.archive_time import ArchiveTimeRange
from backend.source_context import SourceContextProjector
from backend.vector_models import NormalizedMessage, RetrievedChunk

MAX_SEARCH_CHUNKS = 8


class ArchiveContextReader(Protocol):
    def load_message_context(
        self, anchor_id: str, before_count: int, after_count: int,
        scope: Optional[ChatScope],
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[NormalizedMessage]: ...


class ScopedArchiveTools:
    def __init__(
        self, search_chunks: Callable[
            [str, float, Optional[ArchiveTimeRange]], Sequence[RetrievedChunk]
        ],
        projector: SourceContextProjector, context_reader: ArchiveContextReader,
        scope: Optional[ChatScope],
        excluded_message_ids: Optional[Set[str]] = None,
        maximum_timestamp: Optional[datetime] = None,
    ) -> None:
        self.search_chunks = search_chunks
        self.projector = projector
        self.context_reader = context_reader
        self.scope = scope
        self.excluded_message_ids = excluded_message_ids or set()
        self.maximum_timestamp = maximum_timestamp

    def search(
        self, query: str, deadline: float,
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[ChatSource]:
        chunk_result = self.search_chunks(query, deadline, time_range) if time_range else (
            self.search_chunks(query, deadline)
        )
        chunks = list(chunk_result)[:MAX_SEARCH_CHUNKS]
        sources = self.projector.project_chunks(chunks)
        return [source for source in sources if self._allowed(source, time_range)]

    def read_context(
        self, anchor_source: ChatSource, before_count: int, after_count: int,
        time_range: Optional[ArchiveTimeRange] = None,
    ) -> List[ChatSource]:
        if len(anchor_source.source_message_ids) != 1:
            raise ValueError("Context can only be loaded for one original message.")
        arguments = (
            anchor_source.source_message_ids[0], before_count, after_count, self.scope,
        )
        messages = self.context_reader.load_message_context(
            *arguments, time_range,
        ) if time_range else self.context_reader.load_message_context(*arguments)
        return [
            source for message in messages
            if self._allowed(source := self._context_source(message), time_range)
        ]

    def _allowed(
        self, source: ChatSource, time_range: Optional[ArchiveTimeRange],
    ) -> bool:
        if any(item in self.excluded_message_ids for item in source.source_message_ids):
            return False
        if time_range and not time_range.contains(source.timestamp):
            return False
        return not self.maximum_timestamp or self._before_cutoff(source.timestamp)

    def _before_cutoff(self, timestamp: Optional[datetime]) -> bool:
        if not timestamp:
            return False
        value = timestamp.replace(tzinfo=timezone.utc) if timestamp.tzinfo is None else timestamp
        cutoff = self.maximum_timestamp
        cutoff = cutoff.replace(tzinfo=timezone.utc) if cutoff.tzinfo is None else cutoff
        return value.astimezone(timezone.utc) < cutoff.astimezone(timezone.utc)

    @staticmethod
    def _context_source(message: NormalizedMessage) -> ChatSource:
        return ChatSource(
            author=message.author, content=message.content,
            timestamp=message.timestamp,
            channel=message.conversation_label or message.channel,
            similarity_score=0.0, match_score=0.0, score_kind="unknown",
            source_message_ids=[message.external_id],
            channel_id=message.channel_id, guild_id=message.guild_id,
            source_type=message.source_type,
            conversation_id=message.conversation_id,
            evidence_origin="context",
        )
