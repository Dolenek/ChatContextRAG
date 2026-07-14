import json

from backend.chat_models import ChatResponse, ChatToolActivity
from backend.chat_stream import stream_chat_records


class StreamingChatService:
    def answer(self, _request, publish):
        running = ChatToolActivity(
            sequence=1, tool_name="search_archive", status="running", query="release",
            timezone_name="Europe/Prague",
        )
        publish("tool_started", running)
        completed = running.model_copy(update={
            "status": "completed", "result_message_count": 4,
            "new_evidence_count": 3, "duration_ms": 12,
        })
        publish("tool_completed", completed)
        return ChatResponse(
            answer="Done [E1].", sources=[], retrieval_mode="adaptive",
            evidence_character_limit=24000, tool_activity=[completed],
        )


class FailingChatService:
    def answer(self, _request, publish):
        publish("tool_started", ChatToolActivity(
            sequence=1, tool_name="search_archive", status="running", query="release",
        ))
        raise ValueError("Invalid archive date.")


def test_stream_orders_activity_before_complete_final_response() -> None:
    records = records_from(StreamingChatService())

    assert [record["type"] for record in records] == [
        "tool_started", "tool_completed", "final",
    ]
    assert records[1]["activity"]["result_message_count"] == 4
    assert records[2]["response"]["tool_activity"][0]["new_evidence_count"] == 3


def test_stream_can_report_safe_error_after_it_has_started() -> None:
    records = records_from(FailingChatService())

    assert records[0]["type"] == "tool_started"
    assert records[1] == {
        "type": "error", "code": "invalid_request",
        "detail": "Invalid archive date.",
    }


def records_from(service) -> list[dict]:
    return [json.loads(line) for line in stream_chat_records(service, object())]
