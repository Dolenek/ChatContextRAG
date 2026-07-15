from typing import List, Optional

from backend.models import IndexingJobView, IngestionSessionView


class RawRepositoryJobOperations:
    def finish_session(
        self, session_id: str, reason: str, queue_indexing: bool = True,
    ) -> IngestionSessionView:
        return self.job_repository.finish_session(session_id, reason, queue_indexing)

    def get_session(self, session_id: str) -> IngestionSessionView:
        return self.job_repository.get_session(session_id)

    def queue_session_indexing(self, session_id: str) -> IngestionSessionView:
        return self.job_repository.queue_session_indexing(session_id)

    def get_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.get(job_id)

    def list_jobs(self, limit: int = 10) -> List[IndexingJobView]:
        return self.job_repository.list(limit)

    def list_active_jobs(self) -> List[IndexingJobView]:
        return self.job_repository.list_active()

    def retry_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.retry(job_id)

    def cancel_job(self, job_id: str) -> IndexingJobView:
        return self.job_repository.cancel(job_id)

    def queue_pending_messages(self) -> IndexingJobView:
        job_id = self.pending_job_creator.queue()
        return self.job_repository.get(job_id)

    def claim_next_job(self, worker_id: str) -> Optional[IndexingJobView]:
        return self.job_repository.claim_next(worker_id)

    def update_job_progress(
        self, job_id: str, worker_id: str, processed_messages: int,
        stored_chunks: int,
    ) -> bool:
        return self.job_repository.update_progress(
            job_id, worker_id, processed_messages, stored_chunks,
        )

    def prepare_job_total(self, job_id: str, session_id: str, worker_id: str) -> int:
        return self.job_repository.prepare_total(job_id, session_id, worker_id)

    def renew_job_lease(self, job_id: str, worker_id: str) -> bool:
        return self.job_repository.renew_lease(job_id, worker_id)

    def fail_job(self, job_id: str, worker_id: str, error: str) -> None:
        self.job_repository.fail(job_id, worker_id, error)
