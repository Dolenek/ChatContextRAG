from fastapi import FastAPI, Query
from fastapi.responses import StreamingResponse

from backend.chat_models import (
    ChatRequest, ChatResponse, ChatScopeList, ChatSessionDetail,
    ChatSessionRename, ChatSessionSummary,
)
from backend.chat_stream import stream_chat_records
from backend.chat_service import DatabaseChatService


def register_chat_routes(
    application: FastAPI, chat_service: DatabaseChatService,
) -> None:
    @application.get("/chat/scopes", response_model=ChatScopeList)
    def chat_scopes() -> ChatScopeList:
        return chat_service.list_scopes()

    @application.post("/chat", response_model=ChatResponse)
    def chat(request: ChatRequest) -> ChatResponse:
        return chat_service.answer(request)

    @application.post("/chat/stream")
    def stream_chat(request: ChatRequest) -> StreamingResponse:
        return StreamingResponse(
            stream_chat_records(chat_service, request),
            media_type="application/x-ndjson",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @application.get("/chat/sessions", response_model=list[ChatSessionSummary])
    def chat_sessions(
        limit: int = Query(default=10, ge=1, le=100),
    ) -> list[ChatSessionSummary]:
        return chat_service.list_sessions(limit)

    @application.get("/chat/sessions/{session_id}", response_model=ChatSessionDetail)
    def chat_session(session_id: str) -> ChatSessionDetail:
        return chat_service.get_session(session_id)

    @application.patch("/chat/sessions/{session_id}", response_model=ChatSessionSummary)
    def rename_chat_session(
        session_id: str, request: ChatSessionRename,
    ) -> ChatSessionSummary:
        return chat_service.rename_session(session_id, request.title)

    @application.delete("/chat/sessions/{session_id}")
    def delete_chat_session(session_id: str) -> dict:
        chat_service.delete_session(session_id)
        return {"deleted": True}
