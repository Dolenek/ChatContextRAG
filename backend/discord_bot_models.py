from datetime import datetime
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, model_validator

from backend.chat_models import (
    DEFAULT_EVIDENCE_CHARACTER_LIMIT, MAX_EVIDENCE_CHARACTER_LIMIT,
    MIN_EVIDENCE_CHARACTER_LIMIT, ReasoningEffort, RetrievalMode,
)


DiscordCapability = Literal["sync", "ask"]
DiscordSubjectType = Literal["role", "user"]
DiscordAnswerStatus = Literal[
    "generating", "generated", "delivered", "failed", "delivery_failed",
]
DiscordAnswerBasis = Literal["room_context", "general_knowledge"]


class DiscordBotModelSettings(BaseModel):
    chat_provider_id: Optional[str] = Field(default=None, max_length=100)
    chat_model: Optional[str] = Field(default=None, max_length=200)
    reasoning_effort: Optional[ReasoningEffort] = None
    retrieval_mode: RetrievalMode = "deterministic"
    evidence_character_limit: Optional[int] = Field(
        default=None, ge=MIN_EVIDENCE_CHARACTER_LIMIT,
        le=MAX_EVIDENCE_CHARACTER_LIMIT,
    )

    @model_validator(mode="after")
    def normalize_limit(self):
        if bool(self.chat_provider_id) != bool(self.chat_model):
            raise ValueError("Discord bot provider and model must be configured together.")
        if self.retrieval_mode == "adaptive" and self.evidence_character_limit is None:
            self.evidence_character_limit = DEFAULT_EVIDENCE_CHARACTER_LIMIT
        if self.retrieval_mode == "deterministic":
            self.evidence_character_limit = None
        return self


class DiscordPermissionSubject(BaseModel):
    subject_type: DiscordSubjectType
    subject_id: str = Field(min_length=1, max_length=128)
    display_name: str = Field(min_length=1, max_length=200)


class DiscordGuildPermissions(BaseModel):
    guild_id: str = Field(min_length=1, max_length=128)
    guild_name: str = Field(min_length=1, max_length=200)
    sync_subjects: List[DiscordPermissionSubject] = Field(default_factory=list, max_length=500)
    ask_subjects: List[DiscordPermissionSubject] = Field(default_factory=list, max_length=500)


class DiscordBotSettingsView(BaseModel):
    model: DiscordBotModelSettings
    guilds: List[DiscordGuildPermissions] = Field(default_factory=list)


class DiscordRecentMessage(BaseModel):
    message_id: str = Field(min_length=1, max_length=128)
    author: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=8000)
    timestamp: datetime
    channel_id: str = Field(min_length=1, max_length=128)
    guild_id: str = Field(min_length=1, max_length=128)


class DiscordBotAnswerRequest(BaseModel):
    guild_id: str = Field(min_length=1, max_length=128)
    guild_name: str = Field(min_length=1, max_length=200)
    channel_id: str = Field(min_length=1, max_length=128)
    channel_name: str = Field(min_length=1, max_length=300)
    requester_id: str = Field(min_length=1, max_length=128)
    requester_name: str = Field(min_length=1, max_length=200)
    trigger_message_id: str = Field(min_length=1, max_length=128)
    trigger_type: Literal["mention", "reply"]
    trigger_at: datetime
    reply_to_message_id: Optional[str] = Field(default=None, max_length=128)
    question: str = Field(min_length=2, max_length=2000)
    recent_context: List[DiscordRecentMessage] = Field(default_factory=list, max_length=10)
    warnings: List[str] = Field(default_factory=list, max_length=10)


class DiscordAnswerEvidence(BaseModel):
    evidence_id: str = Field(pattern=r"^E[1-9][0-9]*$")
    origin: Literal["recent", "search", "text_search", "context"]
    author: str
    content: str
    timestamp: Optional[datetime] = None
    channel_id: Optional[str] = None
    guild_id: Optional[str] = None
    message_id: Optional[str] = None
    match_score: Optional[float] = None
    cited: bool = False


class DiscordBotAnswerResult(BaseModel):
    answer_id: str
    answer: str
    basis: DiscordAnswerBasis
    evidence: List[DiscordAnswerEvidence] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)


class DiscordBotDeliveryUpdate(BaseModel):
    status: Literal["delivered", "failed"] = "delivered"
    message_ids: List[str] = Field(default_factory=list, max_length=20)
    warning: Optional[str] = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def require_delivered_message(self):
        if self.status == "delivered" and not self.message_ids:
            raise ValueError("Delivered Discord answer requires a message ID.")
        return self


class DiscordBotAnswerSummary(BaseModel):
    answer_id: str
    guild_id: str
    guild_name: str
    channel_id: str
    channel_name: str
    requester_id: str
    requester_name: str
    question: str
    answer: Optional[str] = None
    status: DiscordAnswerStatus
    basis: Optional[DiscordAnswerBasis] = None
    created_at: datetime


class DiscordBotAnswerDetail(DiscordBotAnswerSummary):
    trigger_message_id: str
    trigger_type: Literal["mention", "reply"]
    parent_answer_id: Optional[str] = None
    chat_provider_id: Optional[str] = None
    chat_model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    retrieval_mode: Optional[RetrievalMode] = None
    evidence_character_limit: Optional[int] = None
    recent_context: List[DiscordRecentMessage] = Field(default_factory=list)
    evidence: List[DiscordAnswerEvidence] = Field(default_factory=list)
    cited_evidence_ids: List[str] = Field(default_factory=list)
    tool_activity: List[dict] = Field(default_factory=list)
    warnings: List[str] = Field(default_factory=list)
    error_code: Optional[str] = None
    response_message_ids: List[str] = Field(default_factory=list)
    trigger_at: datetime
    completed_at: Optional[datetime] = None


class DiscordBotAnswerPage(BaseModel):
    items: List[DiscordBotAnswerSummary] = Field(default_factory=list)
    total: int = 0
    limit: int
    offset: int
