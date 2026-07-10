from datetime import datetime, timezone

from backend.chunking import ConversationAwareChunker
from backend.models import DiscordMessageInput, ImportRequest
from backend.normalization import DiscordMessageNormalizer
from backend.services import MessageIngestionService


class FakeEmbeddingProvider:
    model_name = "test-embedding"

    def embed_texts(self, texts):
        self.received_texts = list(texts)
        return [[float(index), 0.0, 1.0] for index, _text in enumerate(texts)]


class FakeVectorRepository:
    def upsert_chunks(self, chunks):
        self.chunks = list(chunks)
        return len(self.chunks)


def test_ingestion_normalizes_chunks_and_embeds_conversation() -> None:
    embedding_provider = FakeEmbeddingProvider()
    repository = FakeVectorRepository()
    service = MessageIngestionService(
        DiscordMessageNormalizer(), ConversationAwareChunker(), embedding_provider, repository
    )
    messages = [
        DiscordMessageInput(
            external_id="1", author=" Ada ", content="  Ahoj   světe ",
            timestamp=datetime(2026, 7, 10, 10, 0, tzinfo=timezone.utc), channel="general",
        ),
        DiscordMessageInput(
            external_id="2", author="Bob", content="Navazující odpověď",
            timestamp=datetime(2026, 7, 10, 10, 2, tzinfo=timezone.utc), channel="general",
        ),
    ]

    result = service.ingest(ImportRequest(messages=messages))

    assert result.chunk_count == 1
    assert "Ada: Ahoj světe" in embedding_provider.received_texts[0]
    assert repository.chunks[0].chunk.source_message_ids == ["1", "2"]
