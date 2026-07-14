import json
import queue
import threading
from typing import Iterator

from backend.chat_sessions import ChatSessionNotFoundError
from backend.openai_gateway import ExternalIntegrationError


class ChatStreamCancelled(RuntimeError):
    pass


def stream_chat_records(chat_service, request) -> Iterator[str]:
    records: queue.Queue = queue.Queue()
    cancelled = threading.Event()
    finished = object()

    def publish(event_type, activity) -> None:
        if cancelled.is_set():
            raise ChatStreamCancelled("Chat stream was disconnected.")
        records.put({
            "type": event_type,
            "activity": activity.model_dump(mode="json"),
        })

    def run_chat() -> None:
        try:
            response = chat_service.answer(request, publish)
            records.put({"type": "final", "response": response.model_dump(mode="json")})
        except ChatStreamCancelled:
            pass
        except Exception as error:
            records.put(_error_record(error))
        finally:
            records.put(finished)

    threading.Thread(target=run_chat, daemon=True, name="adaptive-chat-stream").start()
    try:
        while True:
            record = records.get()
            if record is finished:
                break
            yield json.dumps(record, ensure_ascii=False) + "\n"
    finally:
        cancelled.set()


def _error_record(error: Exception) -> dict:
    if isinstance(error, ChatSessionNotFoundError):
        return {"type": "error", "code": "not_found", "detail": str(error)}
    if isinstance(error, ValueError):
        return {"type": "error", "code": "invalid_request", "detail": str(error)}
    if isinstance(error, ExternalIntegrationError):
        return {"type": "error", "code": "integration_error", "detail": str(error)}
    return {
        "type": "error", "code": "internal_error",
        "detail": "Adaptive chat failed unexpectedly.",
    }
