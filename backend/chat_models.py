from datetime import date, datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator


ReasoningEffort = Literal[
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
]
RetrievalMode = Literal["deterministic", "adaptive"]
ToolName = Literal["search_archive", "read_message_context", "unknown"]
ToolActivityStatus = Literal["running", "completed", "failed", "skipped"]

DEFAULT_EVIDENCE_CHARACTER_LIMIT = 24_000
MIN_EVIDENCE_CHARACTER_LIMIT = 4_000
MAX_EVIDENCE_CHARACTER_LIMIT = 48_000


class ChatHistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=10000)


class ChatScope(BaseModel):
    source_type: str = Field(
        min_length=1, max_length=50, pattern=r"^[a-z][a-z0-9_-]*$",
    )
    conversation_id: str = Field(min_length=1, max_length=256)


class ChatScopeOption(ChatScope):
    display_name: str = Field(min_length=1, max_length=300)
    container_name: Optional[str] = Field(default=None, max_length=300)
    message_count: int = Field(default=0, ge=0)


class ChatScopeList(BaseModel):
    scopes: List[ChatScopeOption] = Field(default_factory=list)


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    history: List[ChatHistoryTurn] = Field(default_factory=list, max_length=12)
    scope: Optional[ChatScope] = None
    chat_provider_id: Optional[str] = Field(default=None, min_length=1, max_length=100)
    chat_model: Optional[str] = Field(default=None, min_length=1, max_length=200)
    reasoning_effort: Optional[ReasoningEffort] = None
    session_id: Optional[str] = Field(default=None, min_length=1, max_length=64)
    retrieval_mode: RetrievalMode = "deterministic"
    evidence_character_limit: Optional[int] = Field(
        default=None,
        ge=MIN_EVIDENCE_CHARACTER_LIMIT,
        le=MAX_EVIDENCE_CHARACTER_LIMIT,
    )

    @model_validator(mode="after")
    def normalize_evidence_limit(self):
        if self.retrieval_mode == "adaptive" and self.evidence_character_limit is None:
            self.evidence_character_limit = DEFAULT_EVIDENCE_CHARACTER_LIMIT
        if self.retrieval_mode == "deterministic":
            self.evidence_character_limit = None
        return self


class ChatSourceChunk(BaseModel):
    chunk_id: Optional[str] = None
    content: str
    source_message_ids: List[str] = Field(default_factory=list)
    origin: Literal["retrieved", "reconstructed"] = "retrieved"


class ChatSource(BaseModel):
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]
    similarity_score: float
    match_score: Optional[float] = Field(default=None, ge=0, le=1)
    score_kind: Literal["rrf", "cosine", "unknown"] = "unknown"
    chunk: Optional[ChatSourceChunk] = None
    source_message_ids: List[str] = Field(default_factory=list)
    channel_id: Optional[str] = None
    guild_id: Optional[str] = None
    source_type: str = "discord"
    conversation_id: Optional[str] = None
    evidence_origin: Literal["search", "context"] = "search"


class ChatToolActivity(BaseModel):
    sequence: int = Field(ge=1)
    tool_name: ToolName
    status: ToolActivityStatus
    query: Optional[str] = Field(default=None, max_length=1000)
    date_from: Optional[date] = None
    date_to: Optional[date] = None
    timezone_name: Optional[str] = Field(default=None, max_length=100)
    normalized_start_at: Optional[datetime] = None
    normalized_end_at: Optional[datetime] = None
    evidence_id: Optional[str] = Field(default=None, max_length=32)
    before_count: Optional[int] = Field(default=None, ge=0, le=10)
    after_count: Optional[int] = Field(default=None, ge=0, le=10)
    result_message_count: Optional[int] = Field(default=None, ge=0)
    new_evidence_count: Optional[int] = Field(default=None, ge=0)
    budget_exhausted: bool = False
    error_code: Optional[str] = Field(default=None, max_length=100)
    duration_ms: Optional[int] = Field(default=None, ge=0)


class ChatResponse(BaseModel):
    answer: str
    sources: List[ChatSource]
    chat_provider_id: Optional[str] = None
    chat_model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    embedding_index_id: Optional[str] = None
    chat_session_id: Optional[str] = None
    chat_session_title: Optional[str] = None
    retrieval_mode: RetrievalMode = "deterministic"
    evidence_character_limit: Optional[int] = None
    tool_activity: List[ChatToolActivity] = Field(default_factory=list)


class ChatSessionSummary(BaseModel):
    session_id: str
    title: str
    created_at: datetime
    updated_at: datetime


class ChatSessionMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    sources: List[ChatSource] = Field(default_factory=list)
    created_at: Optional[datetime] = None
    tool_activity: List[ChatToolActivity] = Field(default_factory=list)


class ChatSessionDetail(ChatSessionSummary):
    scope: Optional[ChatScope] = None
    chat_provider_id: Optional[str] = None
    chat_model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    retrieval_mode: RetrievalMode = "deterministic"
    evidence_character_limit: Optional[int] = None
    messages: List[ChatSessionMessage] = Field(default_factory=list)


class ChatSessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)
