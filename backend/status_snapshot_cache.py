from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from threading import RLock
from time import monotonic
from typing import Callable, Generic, Optional, TypeVar


SnapshotValue = TypeVar("SnapshotValue")


@dataclass(frozen=True)
class SnapshotResult(Generic[SnapshotValue]):
    value: SnapshotValue
    generated_at: datetime
    is_stale: bool
    refreshing: bool


class DatabaseSummaryCache(Generic[SnapshotValue]):
    def __init__(
        self, loader: Callable[[], SnapshotValue], ttl_seconds: float = 60,
        force_coalesce_seconds: float = 5, clock: Callable[[], float] = monotonic,
        executor: Optional[ThreadPoolExecutor] = None,
    ) -> None:
        self.loader = loader
        self.ttl_seconds = ttl_seconds
        self.force_coalesce_seconds = force_coalesce_seconds
        self.clock = clock
        self.executor = executor or ThreadPoolExecutor(max_workers=1)
        self.owns_executor = executor is None
        self.lock = RLock()
        self.value: Optional[SnapshotValue] = None
        self.generated_at: Optional[datetime] = None
        self.loaded_at = 0.0
        self.retry_after = 0.0
        self.revision = 0
        self.in_flight: Optional[Future] = None

    def get(self, force: bool = False) -> SnapshotResult[SnapshotValue]:
        with self.lock:
            age = self._age()
            if self.value is not None and self._can_reuse(age, force):
                return self._result(age)
            future = self._ensure_refresh(force)
            if self.value is not None and not force:
                return self._result(age)
        if future is None:
            raise RuntimeError("Database summary refresh could not be scheduled.")
        future.result()
        with self.lock:
            return self._result(self._age())

    def start_refresh(self) -> None:
        with self.lock:
            self._ensure_refresh(False)

    def drop(self) -> None:
        with self.lock:
            self.revision += 1
            self.value = None
            self.generated_at = None
            self.loaded_at = 0.0
            self.retry_after = 0.0
            self.in_flight = None

    def close(self) -> None:
        if self.owns_executor:
            self.executor.shutdown(wait=False, cancel_futures=True)

    def _can_reuse(self, age: float, force: bool) -> bool:
        maximum_age = self.force_coalesce_seconds if force else self.ttl_seconds
        return age < maximum_age

    def _ensure_refresh(self, force: bool) -> Optional[Future]:
        if self.in_flight is not None:
            return self.in_flight
        if not force and self.clock() < self.retry_after:
            return None
        revision = self.revision
        future = self.executor.submit(self._load, revision)
        self.in_flight = future
        future.add_done_callback(lambda completed: self._finish(completed, revision))
        return future

    def _load(self, revision: int) -> tuple:
        return self.loader(), self.clock(), datetime.now(timezone.utc), revision

    def _finish(self, future: Future, revision: int) -> None:
        try:
            value, loaded_at, generated_at, _revision = future.result()
        except Exception:
            with self.lock:
                if self.in_flight is future:
                    self.in_flight = None
                    self.retry_after = self.clock() + self.force_coalesce_seconds
            return
        with self.lock:
            if self.revision == revision:
                self.value = value
                self.loaded_at = loaded_at
                self.generated_at = generated_at
                self.retry_after = 0.0
            if self.in_flight is future:
                self.in_flight = None

    def _age(self) -> float:
        return max(0.0, self.clock() - self.loaded_at)

    def _result(self, age: float) -> SnapshotResult[SnapshotValue]:
        if self.value is None or self.generated_at is None:
            raise RuntimeError("Database summary cache is empty.")
        return SnapshotResult(
            value=self.value, generated_at=self.generated_at,
            is_stale=age >= self.ttl_seconds,
            refreshing=self.in_flight is not None,
        )
