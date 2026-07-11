import threading
from dataclasses import replace
from typing import Iterable, Iterator, List

from backend.chunking import ConversationAwareChunker
from backend.hybrid_repository import PostgresHybridRepository
from backend.openai_gateway import EmbeddingProvider
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import EmbeddedChunk, NormalizedMessage


class PersistentIndexingWorker:
    def __init__(
        self,
        raw_repository: PostgresRawMessageRepository,
        hybrid_repository: PostgresHybridRepository,
        chunker: ConversationAwareChunker,
        embedding_provider: EmbeddingProvider,
        embedding_batch_size: int = 64,
    ) -> None:
        self.raw_repository = raw_repository
        self.hybrid_repository = hybrid_repository
        self.chunker = chunker
        self.embedding_provider = embedding_provider
        self.embedding_batch_size = embedding_batch_size
        self._wake_event = threading.Event()
        self._thread = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self.raw_repository.reset_running_jobs()
        self._thread = threading.Thread(target=self._run, daemon=True, name="rag-indexer")
        self._thread.start()

    def wake(self) -> None:
        self._wake_event.set()

    def _run(self) -> None:
        while True:
            job = self.raw_repository.claim_next_job()
            if not job:
                self._wake_event.wait(2)
                self._wake_event.clear()
                continue
            self._process_job(job.job_id, job.session_id)

    def _process_job(self, job_id: str, session_id: str) -> None:
        try:
            stored_chunks = 0
            processed_messages = 0
            self.raw_repository.prepare_job_total(job_id, session_id)
            messages = self.raw_repository.iter_indexing_messages(job_id)
            collapsed = self._collapse_stream(messages)
            chunk_stream = self.chunker.chunk_stream(collapsed)
            self.hybrid_repository.delete_chunks_affected_by_session(session_id)
            for batch in self._batched(chunk_stream):
                if self.raw_repository.get_job(job_id).status == "cancelled":
                    return
                embeddings = self.embedding_provider.embed_texts([chunk.content for chunk in batch])
                embedded = [EmbeddedChunk(
                    chunk=chunk, embedding=embedding,
                    embedding_model=self.embedding_provider.model_name,
                ) for chunk, embedding in zip(batch, embeddings)]
                stored_chunks += self.hybrid_repository.upsert_chunks(embedded)
                processed_messages += sum(len(chunk.source_message_ids) for chunk in batch)
                self.raw_repository.update_job_progress(
                    job_id, processed_messages, stored_chunks,
                )
            self.raw_repository.complete_job(job_id)
        except Exception as error:
            self.raw_repository.fail_job(job_id, str(error))

    @staticmethod
    def _collapse_consecutive_duplicates(
        messages: List[NormalizedMessage],
    ) -> List[NormalizedMessage]:
        return list(PersistentIndexingWorker._collapse_stream(messages))

    @staticmethod
    def _collapse_stream(
        messages: Iterable[NormalizedMessage],
    ) -> Iterator[NormalizedMessage]:
        current = None
        related_ids = []
        for message in messages:
            if current and message.author == current.author and message.content == current.content:
                related_ids.append(message.external_id)
                continue
            if current:
                yield PersistentIndexingWorker._with_repetition(current, related_ids)
            current = message
            related_ids = []
        if current:
            yield PersistentIndexingWorker._with_repetition(current, related_ids)

    @staticmethod
    def _with_repetition(message: NormalizedMessage, related_ids: list) -> NormalizedMessage:
        if not related_ids:
            return message
        return replace(
            message, content=f"{message.content}\n[Opakováno {len(related_ids) + 1}×]",
            related_external_ids=tuple(related_ids),
        )

    def _batched(self, chunks: Iterable) -> Iterator[list]:
        batch = []
        for chunk in chunks:
            batch.append(chunk)
            if len(batch) >= self.embedding_batch_size:
                yield batch
                batch = []
        if batch:
            yield batch
