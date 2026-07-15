from typing import Iterable, List, Optional, Protocol, Sequence, Set

from backend.models import (
    ChatScope, DatabaseBreakdowns, DatabaseChunkPage, DatabaseCountPage,
    DatabaseOverview, DatabaseStatus,
)
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class VectorRepository(Protocol):
    def upsert_chunks(self, chunks: Iterable[EmbeddedChunk]) -> int:
        ...

    def search_similar(
        self, query_embedding: Sequence[float], limit: int = 5,
        scope: Optional[ChatScope] = None,
    ) -> List[RetrievedChunk]:
        ...

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        ...

    def get_database_status(self, fresh: bool = False) -> DatabaseStatus:
        ...

    def get_database_breakdowns(self) -> DatabaseBreakdowns:
        ...

    def get_database_breakdown_page(
        self, dimension: str, limit: int, offset: int,
    ) -> DatabaseCountPage:
        ...

    def get_database_chunk_page(
        self, limit: int, cursor: Optional[str],
    ) -> DatabaseChunkPage:
        ...

    def delete_all(self) -> int:
        ...

    def existing_source_message_ids(self, external_ids: Sequence[str]) -> Set[str]:
        ...

    def find_oldest_source_message_id(
        self, channel_id: str, channel_name: Optional[str]
    ) -> Optional[str]:
        ...
