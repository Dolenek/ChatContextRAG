import time
from typing import Callable, List, Optional

from backend.archive_time import ArchiveTimeRange
from backend.chat_models import ChatToolActivity


ActivityCallback = Callable[[str, ChatToolActivity], None]


class ToolActivityRecorder:
    def __init__(self, callback: Optional[ActivityCallback] = None) -> None:
        self.callback = callback
        self.activities: List[ChatToolActivity] = []

    def start_search(
        self, query: str, time_range: Optional[ArchiveTimeRange], timezone_name: str,
    ):
        activity = ChatToolActivity(
            sequence=len(self.activities) + 1, tool_name="search_archive",
            status="running", query=query,
            date_from=time_range.date_from if time_range else None,
            date_to=time_range.date_to if time_range else None,
            timezone_name=time_range.timezone_name if time_range else timezone_name,
            normalized_start_at=time_range.start_at if time_range else None,
            normalized_end_at=time_range.end_at if time_range else None,
        )
        return self._start(activity)

    def start_context(
        self, evidence_id: str, before_count: int, after_count: int,
        time_range: Optional[ArchiveTimeRange], timezone_name: str,
    ):
        activity = ChatToolActivity(
            sequence=len(self.activities) + 1, tool_name="read_message_context",
            status="running", evidence_id=evidence_id,
            before_count=before_count, after_count=after_count,
            date_from=time_range.date_from if time_range else None,
            date_to=time_range.date_to if time_range else None,
            timezone_name=time_range.timezone_name if time_range else timezone_name,
            normalized_start_at=time_range.start_at if time_range else None,
            normalized_end_at=time_range.end_at if time_range else None,
        )
        return self._start(activity)

    def complete(self, activity, started_at: float, result_count: int, payload: dict):
        completed = activity.model_copy(update={
            "status": "completed", "result_message_count": result_count,
            "new_evidence_count": sum(
                1 for item in payload.get("messages", [])
                if not item.get("already_provided")
            ),
            "budget_exhausted": bool(payload.get("budget_exhausted")),
            "duration_ms": max(0, round((time.monotonic() - started_at) * 1000)),
        })
        self._replace(activity, completed)
        self._emit("tool_completed", completed)
        return completed

    def fail(self, activity, started_at: float, error_code: str):
        failed = activity.model_copy(update={
            "status": "failed", "error_code": error_code,
            "duration_ms": max(0, round((time.monotonic() - started_at) * 1000)),
        })
        self._replace(activity, failed)
        self._emit("tool_failed", failed)

    def skip(self, tool_name: str, error_code: str) -> None:
        skipped = ChatToolActivity(
            sequence=len(self.activities) + 1,
            tool_name=tool_name if tool_name in {
                "search_archive", "read_message_context",
            } else "unknown",
            status="skipped", error_code=error_code,
        )
        self.activities.append(skipped)
        self._emit("tool_skipped", skipped)

    def _start(self, activity):
        self.activities.append(activity)
        self._emit("tool_started", activity)
        return activity, time.monotonic()

    def _replace(self, previous, current) -> None:
        self.activities[previous.sequence - 1] = current

    def _emit(self, event_type: str, activity: ChatToolActivity) -> None:
        if self.callback:
            self.callback(event_type, activity)
