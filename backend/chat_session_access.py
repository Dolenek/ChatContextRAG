from typing import List

from backend.chat_models import (
    ChatRequest, ChatResponse, ChatSessionDetail, ChatSessionSummary,
)
from backend.chat_sessions import ChatSessionRepository


class ChatSessionAccess:
    chat_session_repository: ChatSessionRepository
    source_context_projector: object

    def list_sessions(self, limit: int) -> List[ChatSessionSummary]:
        return self._sessions().list_recent(limit)

    def get_session(self, session_id: str) -> ChatSessionDetail:
        session = self._sessions().get(session_id)
        if not self.source_context_projector:
            return session
        messages = [
            message.model_copy(update={
                "sources": self.source_context_projector.expand_sources(message.sources),
            })
            for message in session.messages
        ]
        return session.model_copy(update={"messages": messages})

    def rename_session(self, session_id: str, title: str) -> ChatSessionSummary:
        return self._sessions().rename(session_id, title)

    def delete_session(self, session_id: str) -> None:
        self._sessions().delete(session_id)

    def _store_answer(self, request: ChatRequest, response: ChatResponse) -> ChatResponse:
        if not self.chat_session_repository:
            return response
        session = self.chat_session_repository.save_turn(request, response)
        return response.model_copy(update={
            "chat_session_id": session.session_id,
            "chat_session_title": session.title,
        })

    def _sessions(self) -> ChatSessionRepository:
        if not self.chat_session_repository:
            raise ValueError("Chat session storage is not configured.")
        return self.chat_session_repository
