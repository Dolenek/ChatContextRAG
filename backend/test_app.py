from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import (
    ChannelResumePoint, ChatResponse, ChatScopeList, ChatScopeOption, ChatSource,
    DatabaseOverview, ImportResponse, IndexingJobView, IngestionSessionView,
)


class FakeIngestionService:
    def ingest(self, request):
        return ImportResponse(
            imported_count=len(request.messages), chunk_count=1, messages=request.messages
        )

    def create_session(self, _request):
        return IngestionSessionView(session_id="session-1", status="running")

    def finish_session(self, session_id, request):
        return IngestionSessionView(
            session_id=session_id, status=request.reason, indexing_job_id="job-1",
        )

    def get_job(self, job_id):
        return IndexingJobView(job_id=job_id, session_id="session-1", status="queued")

    def retry_job(self, job_id):
        return self.get_job(job_id)

    def cancel_job(self, job_id):
        return IndexingJobView(job_id=job_id, session_id="session-1", status="cancelled")

    def queue_pending_messages(self):
        return IndexingJobView(
            job_id="job-pending", session_id="pending-session", status="queued",
            total_messages=84,
        )


class FakeChatService:
    def list_scopes(self):
        return ChatScopeList(scopes=[ChatScopeOption(
            source_type="discord", conversation_id="20", display_name="projekt",
            container_name="10", message_count=42,
        )])

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
    client = _client()
    import_response = client.post("/messages/import", json={"messages": [_message()]})
    chat_response = client.post(
        "/chat", json={"question": "Kdy je termín?", "history": []}
    )
    assert import_response.status_code == 200
    assert import_response.json()["chunk_count"] == 1
    assert chat_response.status_code == 200
    assert "pátek" in chat_response.json()["answer"]


def test_overview_and_ingestion_job_routes() -> None:
    client = _client()
    overview_response = client.get("/database/overview?limit=25&offset=0")
    assert overview_response.status_code == 200
    assert overview_response.json()["total_chunks"] == 0
    session_response = client.post("/ingestion/sessions", json={
        "guild_id": "10", "channel_id": "20", "channel": "projekt",
    })
    finish_response = client.post(
        "/ingestion/sessions/session-1/finish", json={"reason": "completed"},
    )
    job_response = client.get("/indexing/jobs/job-1")
    pending_response = client.post("/indexing/jobs/pending")
    assert session_response.status_code == 200
    assert finish_response.json()["indexing_job_id"] == "job-1"
    assert job_response.json()["status"] == "queued"
    assert pending_response.json()["total_messages"] == 84


def test_chat_scopes_expose_source_neutral_conversation_identity() -> None:
    response = _client().get("/chat/scopes")

    assert response.status_code == 200
    assert response.json()["scopes"] == [{
        "source_type": "discord", "conversation_id": "20",
        "display_name": "projekt", "container_name": "10", "message_count": 42,
    }]


def test_resume_and_database_clear_routes() -> None:
    client = _client()
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


def _client() -> TestClient:
    return TestClient(
        create_app(FakeIngestionService(), FakeChatService(), FakeOverviewService())
    )


def _message() -> dict:
    return {
        "external_id": "123", "author": "Ada", "content": "Termín je v pátek.",
        "timestamp": "2026-07-10T10:00:00Z", "channel": "projekt",
    }
