from types import SimpleNamespace

from backend.chunking import ConversationAwareChunker
from backend.indexing_worker import PersistentIndexingWorker
from backend.vector_models import NormalizedMessage


class FakeRawRepository:
    def __init__(self, message_count):
        self.message_count = message_count
        self.completed = False
        self.failed = None
        self.max_processed = 0

    def prepare_job_total(self, _job_id, _session_id):
        return self.message_count

    def iter_indexing_messages(self, _job_id):
        for index in range(self.message_count):
            yield NormalizedMessage(
                external_id=str(index + 1), author=f"Author {index % 7}",
                content=f"Useful strategy message number {index}", timestamp=None,
                channel="questions", channel_id="20", guild_id="10",
            )

    def get_job(self, _job_id):
        return SimpleNamespace(status="running")

    def update_job_progress(self, _job_id, processed, _chunks):
        self.max_processed = max(self.max_processed, processed)

    def complete_job(self, _job_id):
        self.completed = True

    def fail_job(self, _job_id, error):
        self.failed = error


class FakeHybridRepository:
    def __init__(self):
        self.stored_chunks = 0

    def delete_chunks_affected_by_session(self, _session_id):
        return 0

    def upsert_chunks(self, chunks):
        count = len(list(chunks))
        self.stored_chunks += count
        return count


class FakeEmbeddingProvider:
    model_name = "fake-embedding"

    def __init__(self):
        self.largest_batch = 0

    def embed_texts(self, texts):
        self.largest_batch = max(self.largest_batch, len(texts))
        return [[0.1, 0.2] for _text in texts]


def test_indexer_streams_one_hundred_thousand_messages_in_bounded_batches() -> None:
    raw_repository = FakeRawRepository(100_000)
    hybrid_repository = FakeHybridRepository()
    embedding_provider = FakeEmbeddingProvider()
    worker = PersistentIndexingWorker(
        raw_repository, hybrid_repository, ConversationAwareChunker(),
        embedding_provider, embedding_batch_size=64,
    )

    worker._process_job("job-1", "session-1")

    assert raw_repository.failed is None
    assert raw_repository.completed
    assert raw_repository.max_processed == 100_000
    assert embedding_provider.largest_batch <= 64
    assert hybrid_repository.stored_chunks > 0
