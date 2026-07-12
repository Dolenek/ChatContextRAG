import logging
import threading
import uuid
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace
from typing import Iterable, Iterator, List, Optional

from backend.chunking import ConversationAwareChunker
from backend.hybrid_repository import PostgresHybridRepository
from backend.job_lease import JobLeaseKeeper
from backend.openai_gateway import EmbeddingProvider
from backend.provider_registry import ProviderRegistry
from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.raw_repository import PostgresRawMessageRepository
from backend.vector_models import EmbeddedChunk, NormalizedMessage


LOGGER = logging.getLogger(__name__)


class PersistentIndexingWorker:
    def __init__(
        self,
        raw_repository: PostgresRawMessageRepository,
        hybrid_repository: PostgresHybridRepository,
        chunker: ConversationAwareChunker,
        embedding_provider: Optional[EmbeddingProvider],
        embedding_batch_size: int = 64,
        worker_id: Optional[str] = None,
        lease_renewal_seconds: float = 20,
        provider_registry: Optional[ProviderRegistry] = None,
        index_repository: Optional[PostgresEmbeddingIndexRepository] = None,
    ) -> None:
        self.raw_repository = raw_repository
        self.hybrid_repository = hybrid_repository
        self.chunker = chunker
        self.embedding_provider = embedding_provider
        self.embedding_batch_size = embedding_batch_size
        self.worker_id = worker_id or str(uuid.uuid4())
        self.lease_renewal_seconds = lease_renewal_seconds
        self.provider_registry = provider_registry
        self.index_repository = index_repository
        self._wake_event = threading.Event()
        self._shutdown_event = threading.Event()
        self._thread = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._shutdown_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True, name="rag-indexer")
        self._thread.start()

    def wake(self) -> None:
        self._wake_event.set()

    def stop(self) -> None:
        self._shutdown_event.set()
        self.wake()

    def _run(self) -> None:
        while not self._shutdown_event.is_set():
            try:
                self._process_next_job()
            except Exception:
                LOGGER.exception("Indexing worker iteration failed; retrying.")
                self._wait_for_work()

    def _process_next_job(self) -> None:
        job = self.raw_repository.claim_next_job(self.worker_id)
        if not job:
            self._wait_for_work()
            return
        self._process_job(job)

    def _wait_for_work(self) -> None:
        self._wake_event.wait(2)
        self._wake_event.clear()

    def _process_job(self, job, session_id: Optional[str] = None) -> None:
        if isinstance(job, str):
            job = SimpleNamespace(
                job_id=job, session_id=session_id,
                embedding_index_id=None, job_type="incremental",
            )
        try:
            with JobLeaseKeeper(
                self.raw_repository, job.job_id, self.worker_id, self.lease_renewal_seconds,
            ) as lease:
                self._process_owned_job(job, lease)
        except Exception as error:
            self.raw_repository.fail_job(job.job_id, self.worker_id, str(error))
            if self.index_repository and job.embedding_index_id:
                self.index_repository.mark_failed(job.embedding_index_id, str(error))

    def _process_owned_job(
        self, job, lease: JobLeaseKeeper,
    ) -> None:
        provider = self._embedding_provider_for(job)
        total_messages = self.raw_repository.prepare_job_total(
            job.job_id, job.session_id, self.worker_id,
        )
        if not lease.renew_now():
            return
        if job.embedding_index_id:
            self.hybrid_repository.prepare_staging(
                job.job_id, self.worker_id, job.embedding_index_id,
            )
        else:
            self.hybrid_repository.prepare_staging(job.job_id, self.worker_id)
        messages = self.raw_repository.iter_indexing_messages(job.job_id)
        collapsed = self._collapse_stream(messages, self.chunker.max_gap)
        chunk_stream = self.chunker.chunk_stream(collapsed)
        completed = self._process_batches(
            job.job_id, total_messages, chunk_stream, lease, provider,
            job.embedding_index_id,
        )
        if completed and lease.renew_now():
            if job.embedding_index_id:
                committed = self.hybrid_repository.commit_staged_chunks(
                    job.job_id, job.session_id, self.worker_id,
                    job.embedding_index_id, job.job_type,
                )
                if committed and self.index_repository:
                    self.index_repository.mark_ready(job.embedding_index_id)
            else:
                self.hybrid_repository.commit_staged_chunks(
                    job.job_id, job.session_id, self.worker_id,
                )

    def _process_batches(
        self, job_id: str, total_messages: int, chunks: Iterable,
        lease: JobLeaseKeeper, provider: EmbeddingProvider,
        embedding_index_id: Optional[str],
    ) -> bool:
        stored_chunks = 0
        processed_messages = 0
        for batch in self._batched(chunks):
            if not lease.renew_now():
                return False
            embeddings = provider.embed_texts(
                [chunk.content for chunk in batch],
            )
            if not lease.renew_now():
                return False
            embedded = self._attach_embeddings(batch, embeddings, provider)
            if embedding_index_id:
                stored_chunks += self.hybrid_repository.stage_chunks(
                    job_id, self.worker_id, embedding_index_id, embedded,
                )
            else:
                stored_chunks += self.hybrid_repository.stage_chunks(
                    job_id, self.worker_id, embedded,
                )
            processed_messages = min(
                processed_messages + self._batch_message_count(batch), total_messages,
            )
            if not self.raw_repository.update_job_progress(
                job_id, self.worker_id, processed_messages, stored_chunks,
            ):
                return False
        return True

    def _attach_embeddings(
        self, chunks: list, embeddings: list,
        provider: Optional[EmbeddingProvider] = None,
    ) -> list:
        provider = provider or self.embedding_provider
        if len(embeddings) != len(chunks):
            raise ValueError(
                f"Embedding provider returned {len(embeddings)} vectors for {len(chunks)} chunks."
            )
        expected_dimensions = getattr(self.embedding_provider, "dimensions", None)
        if expected_dimensions and any(
            len(embedding) != expected_dimensions for embedding in embeddings
        ):
            raise ValueError("Embedding provider returned an unexpected vector dimension.")
        return [EmbeddedChunk(
            chunk=chunk, embedding=embedding,
            embedding_model=self.embedding_provider.model_name,
        ) for chunk, embedding in zip(chunks, embeddings)]

    def _embedding_provider_for(self, job) -> EmbeddingProvider:
        if job.embedding_index_id and self.provider_registry and self.index_repository:
            configuration = self.index_repository.get_configuration(job.embedding_index_id)
            requested = configuration.requested_dimensions
            return self.provider_registry.create_embedding_provider(
                configuration.provider_id, configuration.model, requested,
            )
        if not self.embedding_provider:
            raise ValueError("No embedding provider is configured for the indexing job.")
        return self.embedding_provider

    @staticmethod
    def _collapse_consecutive_duplicates(
        messages: List[NormalizedMessage],
    ) -> List[NormalizedMessage]:
        return list(PersistentIndexingWorker._collapse_stream(messages))

    @staticmethod
    def _collapse_stream(
        messages: Iterable[NormalizedMessage],
        max_gap: timedelta = timedelta(minutes=20),
    ) -> Iterator[NormalizedMessage]:
        current = None
        previous = None
        related_messages = []
        for message in messages:
            if current and PersistentIndexingWorker._can_collapse(previous, message, max_gap):
                related_messages.append(message)
                previous = message
                continue
            if current:
                yield PersistentIndexingWorker._with_repetition(current, related_messages)
            current = message
            previous = message
            related_messages = []
        if current:
            yield PersistentIndexingWorker._with_repetition(current, related_messages)

    @staticmethod
    def _can_collapse(
        previous: NormalizedMessage, message: NormalizedMessage, max_gap: timedelta,
    ) -> bool:
        if previous.author != message.author or previous.content != message.content:
            return False
        if (
            previous.source_type, previous.conversation_id or previous.channel_id,
            previous.guild_id, previous.channel_id, previous.channel,
        ) != (
            message.source_type, message.conversation_id or message.channel_id,
            message.guild_id, message.channel_id, message.channel,
        ):
            return False
        if previous.timestamp and message.timestamp:
            return abs(message.timestamp - previous.timestamp) <= max_gap
        return True

    @staticmethod
    def _with_repetition(
        message: NormalizedMessage, related_messages: List[NormalizedMessage],
    ) -> NormalizedMessage:
        if not related_messages:
            return message
        return replace(
            message,
            content=f"{message.content}\n[Opakováno {len(related_messages) + 1}×]",
            related_external_ids=tuple(item.external_id for item in related_messages),
            related_timestamps=tuple(
                item.timestamp for item in related_messages if item.timestamp
            ),
        )

    @staticmethod
    def _batch_message_count(batch: list) -> int:
        return sum(
            len(chunk.source_message_ids)
            for chunk in batch if chunk.metadata.get("part_index", 0) == 0
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
