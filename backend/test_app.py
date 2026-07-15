from datetime import datetime, timezone

from fastapi.testclient import TestClient

from backend.app import create_app
from backend.models import (
    ChannelResumePoint, ChatResponse, ChatScopeList, ChatScopeOption, ChatSource,
    DatabaseBreakdowns, DatabaseChunkPage, DatabaseOverview, DatabaseStatus,
    ImportResponse, IndexingJobView, IngestionSessionView,
    IntegrationSyncState, SourceConversationView,
    ChatScope, ChatSessionDetail, ChatSessionMessage, ChatSessionSummary,
)
from backend.chat_sessions import ChatSessionNotFoundError


TEST_INTERNAL_TOKEN = "backend-test-internal-token"


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
    def __init__(self):
        self.last_request = None

    def list_scopes(self):
        return ChatScopeList(scopes=[ChatScopeOption(
            source_type="discord", conversation_id="20", display_name="projekt",
            container_name="10", message_count=42,
        )])

    def answer(self, request):
        self.last_request = request
        return ChatResponse(
            answer="Termín je v pátek [1].",
            sources=[
                ChatSource(
                    author="Ada", content="Termín je v pátek.", timestamp=None,
                    channel="projekt", similarity_score=0.92,
                )
            ], retrieval_mode=request.retrieval_mode,
            evidence_character_limit=request.evidence_character_limit,
        )

    def list_sessions(self, limit):
        return [self._summary()][:limit]

    def get_session(self, session_id):
        if session_id == "missing":
            raise ChatSessionNotFoundError("Chat session was not found.")
        return ChatSessionDetail(
            **self._summary().model_dump(),
            scope=ChatScope(source_type="discord", conversation_id="20"),
            chat_provider_id="openai", chat_model="chat-model",
            reasoning_effort="high",
            messages=[ChatSessionMessage(role="user", content="Kdy je termín?")],
        )

    def rename_session(self, session_id, title):
        summary = self._summary()
        return summary.model_copy(update={"session_id": session_id, "title": title})

    def delete_session(self, session_id):
        if session_id == "missing":
            raise ChatSessionNotFoundError("Chat session was not found.")

    @staticmethod
    def _summary():
        timestamp = datetime(2026, 7, 14, tzinfo=timezone.utc)
        return ChatSessionSummary(
            session_id="session-1", title="Kdy je termín?",
            created_at=timestamp, updated_at=timestamp,
        )


class FakeOverviewService:
    deleted_chunks = 0

    def get_overview(self, limit, offset):
        return DatabaseOverview(
            total_chunks=0, total_source_messages=0, total_channels=0, total_authors=0,
            oldest_message_at=None, newest_message_at=None, channels=[], authors=[],
            embedding_models=[], chunks=[], limit=limit, offset=offset, has_more=False,
        )

    def get_status(self, _fresh=False):
        return DatabaseStatus(
            total_chunks=0, total_source_messages=0, total_channels=0,
            total_authors=0, oldest_message_at=None, newest_message_at=None,
        )

    def get_breakdowns(self):
        return DatabaseBreakdowns()

    def get_chunk_page(self, _limit, cursor):
        if cursor == "invalid":
            raise ValueError("Invalid database chunk cursor.")
        return DatabaseChunkPage()

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


def test_chat_validates_reasoning_effort_values() -> None:
    client = _client()

    valid = client.post("/chat", json={
        "question": "Kdy je termín?", "reasoning_effort": "max",
    })
    invalid = client.post("/chat", json={
        "question": "Kdy je termín?", "reasoning_effort": "extreme",
    })

    assert valid.status_code == 200
    assert invalid.status_code == 422


def test_chat_defaults_to_deterministic_and_resolves_adaptive_evidence_limit() -> None:
    chat_service = FakeChatService()
    client = TestClient(create_app(
        FakeIngestionService(), chat_service, FakeOverviewService(),
        internal_token=TEST_INTERNAL_TOKEN,
    ), headers={"X-Chat-Context-Token": TEST_INTERNAL_TOKEN})

    legacy = client.post("/chat", json={"question": "old request"})
    adaptive = client.post("/chat", json={
        "question": "new request", "retrieval_mode": "adaptive",
    })

    assert legacy.json()["retrieval_mode"] == "deterministic"
    assert legacy.json()["evidence_character_limit"] is None
    assert adaptive.json()["retrieval_mode"] == "adaptive"
    assert adaptive.json()["evidence_character_limit"] == 24000


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
    status_response = client.get("/database/status")
    breakdown_response = client.get("/database/breakdowns")
    chunks_response = client.get("/database/chunks?limit=25")
    invalid_cursor = client.get("/database/chunks?cursor=invalid")
    assert overview_response.status_code == 200
    assert overview_response.json()["total_chunks"] == 0
    assert status_response.json()["total_chunks"] == 0
    assert breakdown_response.json()["channels"] == []
    assert chunks_response.json()["has_more"] is False
    assert invalid_cursor.status_code == 400
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


def test_chat_session_crud_routes_and_not_found_response() -> None:
    client = _client()

    listed = client.get("/chat/sessions?limit=10")
    detail = client.get("/chat/sessions/session-1")
    renamed = client.patch("/chat/sessions/session-1", json={"title": "Nový název"})
    deleted = client.delete("/chat/sessions/session-1")
    missing = client.get("/chat/sessions/missing")

    assert listed.json()[0]["title"] == "Kdy je termín?"
    assert detail.json()["messages"][0]["role"] == "user"
    assert detail.json()["reasoning_effort"] == "high"
    assert renamed.json()["title"] == "Nový název"
    assert deleted.json() == {"deleted": True}
    assert missing.status_code == 404


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


def _client() -> TestClient:
    application = create_app(
        FakeIngestionService(), FakeChatService(), FakeOverviewService(),
        internal_token=TEST_INTERNAL_TOKEN,
    )
    return TestClient(
        application, headers={"X-Chat-Context-Token": TEST_INTERNAL_TOKEN},
    )


def _message() -> dict:
    return {
        "external_id": "123", "author": "Ada", "content": "Termín je v pátek.",
        "timestamp": "2026-07-10T10:00:00Z", "channel": "projekt",
    }
