import asyncio

import pytest
from fastapi.testclient import TestClient

from backend.app import _read_import_file, create_app
from backend.models import (
    ChannelResumePoint, ChatResponse, ChatScopeList, ChatScopeOption, ChatSource,
    DatabaseOverview, ImportResponse, IndexingJobView, IngestionSessionView,
    IntegrationSyncState, SourceConversationView,
)
from backend.openai_gateway import ExternalIntegrationError, IntegrationConfigurationError


class FakeIngestionService:
    def ingest(self, request):
        return ImportResponse(
            imported_count=len(request.messages), chunk_count=1, messages=request.messages
        )

    def create_session(self, _request):
        return IngestionSessionView(session_id="session-1", status="running")

    def finish_session(self, session_id, request):
        return IngestionSessionView(
            session_id=session_id, status=request.reason,
            indexing_job_id="job-1" if request.queue_indexing else None,
            indexing_job_ids=["job-1"] if request.queue_indexing else [],
        )

    def get_session(self, session_id):
        return IngestionSessionView(
            session_id=session_id, status="completed", raw_message_count=42,
        )

    def queue_session_indexing(self, session_id):
        return IngestionSessionView(
            session_id=session_id, status="completed", raw_message_count=42,
            indexing_job_id="job-migration", indexing_job_ids=["job-migration"],
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

    def list_conversations(self, source_type):
        return [SourceConversationView(
            source_type=source_type, conversation_id="20",
            display_name="projekt", container_name="Workspace", message_count=42,
        )]

    def list_sync_states(self, _source_type):
        return []

    def upsert_sync_state(self, state):
        return state


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


def test_health_and_source_conversation_routes() -> None:
    client = _client()

    health = client.get("/health")
    conversations = client.get("/ingestion/conversations?source_type=discord")
    invalid = client.get("/ingestion/conversations?source_type=Discord!")

    assert health.json() == {"status": "ok"}
    assert conversations.json()[0]["conversation_id"] == "20"
    assert conversations.json()[0]["message_count"] == 42
    assert invalid.status_code == 422


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
    no_index_response = client.post(
        "/ingestion/sessions/session-2/finish",
        json={"reason": "completed", "queue_indexing": False},
    )
    migration_session = client.get("/ingestion/sessions/session-1")
    migration_index = client.post("/ingestion/sessions/session-1/index")
    job_response = client.get("/indexing/jobs/job-1")
    pending_response = client.post("/indexing/jobs/pending")
    retry_response = client.post("/indexing/jobs/job-1/retry")
    cancel_response = client.post("/indexing/jobs/job-1/cancel")
    assert session_response.status_code == 200
    assert finish_response.json()["indexing_job_id"] == "job-1"
    assert no_index_response.json()["indexing_job_id"] is None
    assert migration_session.json()["raw_message_count"] == 42
    assert migration_index.json()["indexing_job_ids"] == ["job-migration"]
    assert job_response.json()["status"] == "queued"
    assert pending_response.json()["total_messages"] == 84
    assert retry_response.json()["status"] == "queued"
    assert cancel_response.json()["status"] == "cancelled"


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


def test_whatsapp_preview_and_import_routes() -> None:
    client = _client()
    export = b"13/7/2026, 09:15 - Ada: Hello\n13/7/2026, 09:16 - Bob: Hi\n"

    preview = client.post(
        "/imports/whatsapp/preview",
        files={"export_file": ("chat.txt", export, "text/plain")},
        data={"timezone_name": "UTC"},
    )
    imported = client.post(
        "/imports/whatsapp",
        files={"export_file": ("chat.txt", export, "text/plain")},
        data={
            "conversation_id": "family", "conversation_label": "Family",
            "date_order": "DMY", "timezone_name": "UTC",
        },
    )

    assert preview.status_code == 200
    assert preview.json()["message_count"] == 2
    assert imported.status_code == 200
    assert imported.json()["imported_count"] == 2
    assert imported.json()["indexing_job_id"] == "job-1"


def test_integration_sync_state_routes() -> None:
    client = _client()
    state = IntegrationSyncState(
        source_type="discord", conversation_id="20", tracking_enabled=True,
    ).model_dump()

    saved = client.post("/integrations/sync-state", json=state)
    listed = client.get("/integrations/sync-states?source_type=discord")

    assert saved.status_code == 200
    assert saved.json()["conversation_id"] == "20"
    assert listed.status_code == 200


def test_application_translates_domain_errors_to_stable_http_responses() -> None:
    expected = [
        (ExternalIntegrationError("provider offline"), 503),
        (IntegrationConfigurationError("provider missing"), 503),
        (ValueError("index conflict"), 409),
    ]
    for error, status_code in expected:
        client = TestClient(create_app(
            FakeIngestionService(), RaisingChatService(error), FakeOverviewService(),
        ))

        response = client.post("/chat", json={"question": "what happened?"})

        assert response.status_code == status_code
        assert response.json() == {"detail": str(error)}


def test_whatsapp_upload_reader_rejects_payloads_over_transport_limit() -> None:
    with pytest.raises(ValueError, match="100 MiB"):
        asyncio.run(_read_import_file(FakeOversizedUpload()))


class RaisingChatService(FakeChatService):
    def __init__(self, error) -> None:
        self.error = error

    def answer(self, _request):
        raise self.error


class FakeOversizedPayload:
    def __len__(self):
        return 100 * 1024 * 1024 + 1


class FakeOversizedUpload:
    async def read(self, maximum_bytes):
        assert maximum_bytes == 100 * 1024 * 1024 + 1
        return FakeOversizedPayload()


def _client() -> TestClient:
    return TestClient(
        create_app(FakeIngestionService(), FakeChatService(), FakeOverviewService())
    )


def _message() -> dict:
    return {
        "external_id": "123", "author": "Ada", "content": "Termín je v pátek.",
        "timestamp": "2026-07-10T10:00:00Z", "channel": "projekt",
    }
