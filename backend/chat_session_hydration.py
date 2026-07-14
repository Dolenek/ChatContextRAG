from backend.chat_models import (
    ChatScope, ChatSessionDetail, ChatSessionMessage, ChatSource, ChatToolActivity,
)


def build_session_detail(row, message_rows) -> ChatSessionDetail:
    scope = ChatScope(source_type=row[2], conversation_id=row[3]) if row[2] else None
    retrieval_mode, evidence_limit, created_at, updated_at = session_settings(row)
    messages = [build_session_message(message) for message in message_rows]
    return ChatSessionDetail(
        session_id=row[0], title=row[1], scope=scope,
        chat_provider_id=row[4], chat_model=row[5], reasoning_effort=row[6],
        retrieval_mode=retrieval_mode, evidence_character_limit=evidence_limit,
        created_at=created_at, updated_at=updated_at, messages=messages,
    )


def session_settings(row) -> tuple:
    if len(row) == 9:
        return "deterministic", None, row[7], row[8]
    return tuple(row[7:11])


def build_session_message(message) -> ChatSessionMessage:
    return ChatSessionMessage(
        role=message[0], content=message[1],
        sources=[ChatSource.model_validate(source) for source in message[2]],
        created_at=message[3],
        tool_activity=[
            ChatToolActivity.model_validate(activity)
            for activity in (message[4] if len(message) > 4 else [])
        ],
    )
