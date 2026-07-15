import logging
import threading
from typing import Optional

from backend.read_models.refresher import PostgresReadModelRefresher
from backend.read_models.store import PostgresReadModelStore


LOGGER = logging.getLogger(__name__)


class ReadModelRefreshWorker:
    def __init__(
        self, store: PostgresReadModelStore,
        refresher: PostgresReadModelRefresher,
        poll_seconds: float = 1.0,
    ) -> None:
        self.store = store
        self.refresher = refresher
        self.poll_seconds = poll_seconds
        self._wake_event = threading.Event()
        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self.store.set_wake_callback(self.wake)

    def start(self) -> None:
        self.store.ensure_schema()
        with self._lock:
            if self._thread and self._thread.is_alive():
                return
            self._stop_event.clear()
            self._thread = threading.Thread(
                target=self._run, name="read-model-refresh", daemon=True,
            )
            self._thread.start()
        self.wake()

    def wake(self) -> None:
        self._wake_event.set()

    def stop(self) -> None:
        self._stop_event.set()
        self._wake_event.set()
        thread = self._thread
        if thread and thread is not threading.current_thread():
            thread.join(timeout=5)
        self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            try:
                refreshed = self.refresher.refresh_next()
            except Exception:
                LOGGER.exception("Read-model worker iteration failed.")
                refreshed = False
            if refreshed:
                continue
            self._wake_event.wait(self.poll_seconds)
            self._wake_event.clear()
