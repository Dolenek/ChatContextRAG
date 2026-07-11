from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import (
    ChannelResumePoint, ChatResponse, ChatSource, DatabaseOverview, ImportResponse,
)


class FakeIngestionService:
    def ingest(self, request):
        return ImportResponse(
            imported_count=len(request.messages), chunk_count=1, messages=request.messages
        )


class FakeChatService:
    def answer(self, request):
        return ChatResponse(
            answer="Termín je v pátek [1].",
            sources=[
                ChatSource(
                    author="Ada", content="Termín je v pátek.", timestamp=None,
                    channel="projekt", similarity_score=0.92,
                )
            ],
        )


class FakeOverviewService:
    deleted_chunks = 0

    def get_overview(self, limit, offset):
        return DatabaseOverview(
            total_chunks=0, total_source_messages=0, total_channels=0, total_authors=0,
            oldest_message_at=None, newest_message_at=None, channels=[], authors=[],
            embedding_models=[], chunks=[], limit=limit, offset=offset, has_more=False,
        )

    def clear_database(self):
        return self.deleted_chunks

    def get_resume_point(self, channel_id, channel_name):
        return ChannelResumePoint(
            message_id="100", channel_id=channel_id, channel=channel_name,
        )


def test_import_and_chat() -> None:
    client = TestClient(
        create_app(FakeIngestionService(), FakeChatService(), FakeOverviewService())
    )
    message = {
        "external_id": "123", "author": "Ada", "content": "Termín je v pátek.",
        "timestamp": "2026-07-10T10:00:00Z", "channel": "projekt",
    }

    import_response = client.post("/messages/import", json={"messages": [message]})
    chat_response = client.post(
        "/chat", json={"question": "Kdy je termín?", "history": []}
    )

    assert import_response.status_code == 200
    assert import_response.json()["chunk_count"] == 1
    assert chat_response.status_code == 200
    assert "pátek" in chat_response.json()["answer"]

    overview_response = client.get("/database/overview?limit=25&offset=0")
    assert overview_response.status_code == 200
    assert overview_response.json()["total_chunks"] == 0

    resume_response = client.get(
        "/database/resume-point?channel_id=456&channel=projekt"
    )
    assert resume_response.status_code == 200
    assert resume_response.json()["message_id"] == "100"

    invalid_clear_response = client.request(
        "DELETE", "/database", json={"confirmation": "NE"}
    )
    valid_clear_response = client.request(
        "DELETE", "/database", json={"confirmation": "VYMAZAT"}
    )
    assert invalid_clear_response.status_code == 422
    assert valid_clear_response.status_code == 200
