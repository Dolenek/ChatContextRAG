from dataclasses import dataclass
from datetime import datetime
from typing import Iterable, Optional


SANITIZED_REFRESH_ERROR = "Poslední přepočet souhrnu selhal."


@dataclass(frozen=True)
class ReadModelMetadata:
    ready: bool = False
    generated_at: Optional[datetime] = None
    stale: bool = True
    refreshing: bool = True
    error: Optional[str] = None

    def public_fields(self) -> dict:
        return {
            "summary_ready": self.ready,
            "summary_generated_at": self.generated_at,
            "summary_is_stale": self.stale,
            "summary_refreshing": self.refreshing,
            "summary_error": self.error,
        }


def metadata_from_state(row, snapshot_exists: bool) -> ReadModelMetadata:
    if not row:
        return ReadModelMetadata()
    requested, published, status, generated_at, last_error = row
    ready = snapshot_exists and published > 0
    stale = not ready or requested > published or status != "ready"
    refreshing = status in {"queued", "running"}
    error = SANITIZED_REFRESH_ERROR if last_error else None
    return ReadModelMetadata(ready, generated_at, stale, refreshing, error)


def combine_metadata(items: Iterable[ReadModelMetadata]) -> ReadModelMetadata:
    values = list(items)
    if not values:
        return ReadModelMetadata()
    timestamps = [item.generated_at for item in values if item.generated_at]
    return ReadModelMetadata(
        ready=all(item.ready for item in values),
        generated_at=min(timestamps) if len(timestamps) == len(values) else None,
        stale=any(item.stale for item in values),
        refreshing=any(item.refreshing for item in values),
        error=next((item.error for item in values if item.error), None),
    )
