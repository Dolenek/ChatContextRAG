from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import ChatResponse, ChatSource, ImportResponse


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


def test_import_and_chat() -> None:
    client = TestClient(create_app(FakeIngestionService(), FakeChatService()))
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
