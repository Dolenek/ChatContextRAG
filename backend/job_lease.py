import logging
import threading
from typing import Protocol


LOGGER = logging.getLogger(__name__)


class JobLeaseRepository(Protocol):
    def renew_job_lease(self, job_id: str, worker_id: str) -> bool:
        ...


class JobLeaseKeeper:
    def __init__(
        self, repository: JobLeaseRepository, job_id: str, worker_id: str,
        renewal_interval_seconds: float = 20,
    ) -> None:
        self.repository = repository
        self.job_id = job_id
        self.worker_id = worker_id
        self.renewal_interval_seconds = renewal_interval_seconds
        self._stop_event = threading.Event()
        self._ownership_lost = threading.Event()
        self._thread = None

    def __enter__(self):
        self._thread = threading.Thread(
            target=self._run, daemon=True, name=f"rag-lease-{self.job_id[:8]}",
        )
        self._thread.start()
        return self

    def __exit__(self, _error_type, _error, _traceback) -> None:
        self._stop_event.set()
        self._thread.join(timeout=1)

    def renew_now(self) -> bool:
        if self._ownership_lost.is_set():
            return False
        owned = self.repository.renew_job_lease(self.job_id, self.worker_id)
        if not owned:
            self._ownership_lost.set()
        return owned

    def _run(self) -> None:
        while not self._stop_event.wait(self.renewal_interval_seconds):
            try:
                if not self.renew_now():
                    return
            except Exception:
                LOGGER.exception("Indexing job lease renewal failed; retrying.")
