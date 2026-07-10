from pathlib import Path

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.repository import SQLiteMessageRepository


def test_import_and_chat(tmp_path: Path) -> None:
    repository = SQLiteMessageRepository(tmp_path / "test.db")
    client = TestClient(create_app(repository))
    message = {
        "external_id": "123",
        "author": "Ada",
        "content": "Termín prezentace je v pátek.",
        "timestamp": "2026-07-10T10:00:00Z",
        "channel": "projekt",
    }

    import_response = client.post("/messages/import", json={"messages": [message]})
    chat_response = client.post("/chat", json={"question": "Kdy je termín prezentace?"})

    assert import_response.status_code == 200
    assert import_response.json()["imported_count"] == 1
    assert chat_response.status_code == 200
    assert "pátek" in chat_response.json()["answer"]
