from typing import Iterable, List, Protocol, Sequence

from backend.vector_models import EmbeddedChunk, RetrievedChunk


class VectorRepository(Protocol):
    def upsert_chunks(self, chunks: Iterable[EmbeddedChunk]) -> int:
        ...

    def search_similar(
        self, query_embedding: Sequence[float], limit: int = 5
    ) -> List[RetrievedChunk]:
        ...
