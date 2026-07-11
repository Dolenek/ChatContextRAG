from typing import Iterable, List, Optional, Protocol, Sequence, Set

from backend.models import DatabaseOverview
from backend.vector_models import EmbeddedChunk, RetrievedChunk


class VectorRepository(Protocol):
    def upsert_chunks(self, chunks: Iterable[EmbeddedChunk]) -> int:
        ...

    def search_similar(
        self, query_embedding: Sequence[float], limit: int = 5
    ) -> List[RetrievedChunk]:
        ...

    def get_overview(self, limit: int, offset: int) -> DatabaseOverview:
        ...

    def delete_all(self) -> int:
        ...

    def existing_source_message_ids(self, external_ids: Sequence[str]) -> Set[str]:
        ...

    def find_oldest_source_message_id(
        self, channel_id: str, channel_name: Optional[str]
    ) -> Optional[str]:
        ...
