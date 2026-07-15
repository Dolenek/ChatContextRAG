import threading

from backend.read_models.worker import ReadModelRefreshWorker


class StoreSpy:
    def __init__(self) -> None:
        self.ensure_calls = 0
        self.wake_callback = None

    def ensure_schema(self) -> None:
        self.ensure_calls += 1

    def set_wake_callback(self, callback) -> None:
        self.wake_callback = callback


class BlockingRefresher:
    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.active_calls = 0
        self.maximum_active_calls = 0

    def refresh_next(self) -> bool:
        self.active_calls += 1
        self.maximum_active_calls = max(self.maximum_active_calls, self.active_calls)
        self.entered.set()
        self.release.wait(timeout=2)
        self.active_calls -= 1
        return False


def test_worker_start_is_nonblocking_idempotent_and_single_threaded() -> None:
    store = StoreSpy()
    refresher = BlockingRefresher()
    worker = ReadModelRefreshWorker(store, refresher, poll_seconds=10)

    worker.start()
    first_thread = worker._thread
    worker.start()
    assert refresher.entered.wait(timeout=1)
    assert worker._thread.is_alive()
    assert worker._thread is first_thread
    assert refresher.maximum_active_calls == 1

    refresher.release.set()
    worker.stop()

    assert store.ensure_calls == 2
    assert worker._thread is None
