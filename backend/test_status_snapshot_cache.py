import threading
import time

import pytest

from backend.status_snapshot_cache import DatabaseSummaryCache


class FakeClock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value


def test_summary_cache_coalesces_fresh_and_forced_reads() -> None:
    clock = FakeClock()
    calls = []
    cache = DatabaseSummaryCache(
        lambda: calls.append(len(calls) + 1) or {"version": len(calls)},
        clock=clock,
    )
    try:
        first = cache.get()
        repeated = cache.get()
        clock.value = 3
        forced = cache.get(force=True)

        assert first.value == {"version": 1}
        assert repeated.value == first.value
        assert forced.value == first.value
        assert calls == [1]
    finally:
        cache.close()


def test_cold_concurrent_readers_share_one_calculation() -> None:
    release = threading.Event()
    started = threading.Event()
    calls = 0

    def load():
        nonlocal calls
        calls += 1
        started.set()
        release.wait(2)
        return {"version": calls}

    cache = DatabaseSummaryCache(load)
    results = []
    readers = [threading.Thread(target=lambda: results.append(cache.get().value))
               for _ in range(3)]
    try:
        for reader in readers:
            reader.start()
        assert started.wait(1)
        release.set()
        for reader in readers:
            reader.join(1)

        assert calls == 1
        assert results == [{"version": 1}] * 3
    finally:
        release.set()
        cache.close()


def test_stale_read_returns_immediately_and_joins_background_refresh() -> None:
    clock = FakeClock()
    release_refresh = threading.Event()
    refresh_started = threading.Event()
    calls = 0

    def load():
        nonlocal calls
        calls += 1
        if calls == 2:
            refresh_started.set()
            release_refresh.wait(2)
        return {"version": calls}

    cache = DatabaseSummaryCache(load, clock=clock)
    try:
        assert cache.get().value == {"version": 1}
        clock.value = 61
        stale = cache.get()
        assert refresh_started.wait(1)
        assert stale.value == {"version": 1}
        assert stale.is_stale is True
        assert stale.refreshing is True

        release_refresh.set()
        refreshed = cache.get(force=True)
        assert refreshed.value == {"version": 2}
    finally:
        release_refresh.set()
        cache.close()


def test_refresh_failure_keeps_snapshot_and_drop_reloads_it() -> None:
    clock = FakeClock()
    failed = threading.Event()
    calls = 0

    def load():
        nonlocal calls
        calls += 1
        if calls == 2:
            failed.set()
            raise RuntimeError("offline")
        return {"version": calls}

    cache = DatabaseSummaryCache(load, clock=clock)
    try:
        assert cache.get().value == {"version": 1}
        clock.value = 61
        assert cache.get().value == {"version": 1}
        assert failed.wait(1)
        time.sleep(0.01)
        retained = cache.get()
        assert retained.value == {"version": 1}
        assert retained.is_stale is True

        cache.drop()
        assert cache.get().value == {"version": 3}
    finally:
        cache.close()


def test_cold_refresh_failure_is_reported() -> None:
    cache = DatabaseSummaryCache(lambda: (_ for _ in ()).throw(RuntimeError("offline")))
    try:
        with pytest.raises(RuntimeError, match="offline"):
            cache.get()
    finally:
        cache.close()
