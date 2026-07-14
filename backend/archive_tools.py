from typing import Callable, List, Optional, Protocol, Sequence

from backend.chat_models import ChatScope, ChatSource
from backend.source_context import SourceContextProjector
from backend.vector_models import NormalizedMessage, RetrievedChunk

MAX_SEARCH_CHUNKS = 8


class ArchiveContextReader(Protocol):
    def load_message_context(
        self, anchor_id: str, before_count: int, after_count: int,
        scope: Optional[ChatScope],
    ) -> List[NormalizedMessage]: ...


class ScopedArchiveTools:
    def __init__(
        self, search_chunks: Callable[[str, float], Sequence[RetrievedChunk]],
        projector: SourceContextProjector, context_reader: ArchiveContextReader,
        scope: Optional[ChatScope],
    ) -> None:
        self.search_chunks = search_chunks
        self.projector = projector
        self.context_reader = context_reader
        self.scope = scope

    def search(self, query: str, deadline: float) -> List[ChatSource]:
        chunks = list(self.search_chunks(query, deadline))[:MAX_SEARCH_CHUNKS]
        return self.projector.project_chunks(chunks)

    def read_context(
        self, anchor_source: ChatSource, before_count: int, after_count: int,
    ) -> List[ChatSource]:
        if len(anchor_source.source_message_ids) != 1:
            raise ValueError("Context can only be loaded for one original message.")
        messages = self.context_reader.load_message_context(
            anchor_source.source_message_ids[0], before_count, after_count, self.scope,
        )
        return [self._context_source(message) for message in messages]

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
