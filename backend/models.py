from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

ReasoningEffort = Literal[
    "none", "minimal", "low", "medium", "high", "xhigh", "max",
]


class SourceMessageInput(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    author: str = Field(default="Neznámý autor", max_length=200)
    content: str = Field(min_length=1, max_length=10000)
    timestamp: Optional[datetime] = None
    channel: Optional[str] = Field(default=None, max_length=300)
    channel_id: Optional[str] = Field(default=None, max_length=128)
    guild_id: Optional[str] = Field(default=None, max_length=128)
    source_type: str = Field(
        default="discord", max_length=50, pattern=r"^[a-z][a-z0-9_-]*$",
    )
    conversation_id: Optional[str] = Field(default=None, max_length=256)
    conversation_label: Optional[str] = Field(default=None, max_length=300)
    container_id: Optional[str] = Field(default=None, max_length=256)
    container_label: Optional[str] = Field(default=None, max_length=300)
    source_metadata: Dict[str, object] = Field(default_factory=dict)
    message_order: Optional[int] = Field(default=None, ge=0)


DiscordMessageInput = SourceMessageInput


class ImportRequest(BaseModel):
    session_id: Optional[str] = Field(default=None, max_length=64)
    messages: List[SourceMessageInput] = Field(min_length=1, max_length=400)


class ImportResponse(BaseModel):
    imported_count: int
    chunk_count: int
    messages: List[SourceMessageInput]
    raw_stored_count: int = 0
    unique_content_count: int = 0


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


class ChatSource(BaseModel):
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]
    similarity_score: float
    source_message_ids: List[str] = Field(default_factory=list)
    channel_id: Optional[str] = None
    guild_id: Optional[str] = None
    source_type: str = "discord"
    conversation_id: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    sources: List[ChatSource]
    chat_provider_id: Optional[str] = None
    chat_model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    embedding_index_id: Optional[str] = None
    chat_session_id: Optional[str] = None
    chat_session_title: Optional[str] = None


class ChatSessionSummary(BaseModel):
    session_id: str
    title: str
    created_at: datetime
    updated_at: datetime


class ChatSessionMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    sources: List[ChatSource] = Field(default_factory=list)


class ChatSessionDetail(ChatSessionSummary):
    scope: Optional[ChatScope] = None
    chat_provider_id: Optional[str] = None
    chat_model: Optional[str] = None
    reasoning_effort: Optional[ReasoningEffort] = None
    messages: List[ChatSessionMessage] = Field(default_factory=list)


class ChatSessionRename(BaseModel):
    title: str = Field(min_length=1, max_length=120)


class HealthResponse(BaseModel):
    status: str


class DatabaseCount(BaseModel):
    label: str
    count: int


class DatabaseChunkView(BaseModel):
    chunk_id: str
    content: str
    authors: List[str]
    source_message_ids: List[str]
    channel: Optional[str]
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    embedding_model: str
    metadata: Dict[str, object]
    updated_at: datetime


class DatabaseOverview(BaseModel):
    total_chunks: int
    total_source_messages: int
    total_channels: int
    total_authors: int
    oldest_message_at: Optional[datetime]
    newest_message_at: Optional[datetime]
    channels: List[DatabaseCount]
    authors: List[DatabaseCount]
    embedding_models: List[DatabaseCount]
    chunks: List[DatabaseChunkView]
    limit: int
    offset: int
    has_more: bool
    raw_message_count: int = 0
    unique_content_count: int = 0
    duplicate_message_count: int = 0
    indexed_message_count: int = 0
    pending_message_count: int = 0
    database_size: str = "0 bytes"
    indexing_jobs: List["IndexingJobView"] = Field(default_factory=list)


class ClearDatabaseRequest(BaseModel):
    confirmation: Literal["VYMAZAT"]


class ClearDatabaseResponse(BaseModel):
    deleted_chunks: int
    deleted_messages: int = 0


class ChannelResumePoint(BaseModel):
    message_id: Optional[str]
    channel_id: str
    channel: Optional[str]


class IngestionSessionRequest(BaseModel):
    guild_id: Optional[str] = Field(default=None, max_length=128)
    channel_id: Optional[str] = Field(default=None, max_length=128)
    channel: Optional[str] = Field(default=None, max_length=300)
    source_type: str = Field(
        default="discord", max_length=50, pattern=r"^[a-z][a-z0-9_-]*$",
    )
    conversation_id: Optional[str] = Field(default=None, max_length=256)
    conversation_label: Optional[str] = Field(default=None, max_length=300)
    container_id: Optional[str] = Field(default=None, max_length=256)
    container_label: Optional[str] = Field(default=None, max_length=300)


class IngestionSessionView(BaseModel):
    session_id: str
    status: Literal["running", "completed", "stopped"]
    raw_message_count: int = 0
    indexing_job_id: Optional[str] = None
    indexing_job_ids: List[str] = Field(default_factory=list)


class FinishIngestionRequest(BaseModel):
    reason: Literal["completed", "stopped"]
    queue_indexing: bool = True


class IndexingJobView(BaseModel):
    job_id: str
    session_id: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"]
    total_messages: int = 0
    processed_messages: int = 0
    stored_chunks: int = 0
    last_error: Optional[str] = None
    started_at: Optional[datetime] = None
    finished_at: Optional[datetime] = None
    embedding_index_id: Optional[str] = None
    embedding_index_name: Optional[str] = None
    job_type: Literal["incremental", "sync", "rebuild"] = "incremental"
    source_type: Optional[str] = None
    source_conversation_label: Optional[str] = None
    source_container_label: Optional[str] = None


class ProviderProfileInput(BaseModel):
    provider_id: str = Field(min_length=1, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    name: str = Field(min_length=1, max_length=100)
    base_url: str = Field(min_length=8, max_length=1000)
    api_key: Optional[str] = Field(default=None, min_length=1, max_length=2000)
    chat_api: Literal["responses", "chat_completions"] = "responses"


class ProviderProfileView(BaseModel):
    provider_id: str
    name: str
    base_url: str
    chat_api: Literal["responses", "chat_completions"]
    has_api_key: bool
    is_available: bool = True
    builtin: bool = False


class ProviderRegistryUpdate(BaseModel):
    providers: List[ProviderProfileInput] = Field(default_factory=list, max_length=50)


class ProviderModelList(BaseModel):
    models: List[str] = Field(default_factory=list)
    warning: Optional[str] = None


class EmbeddingIndexCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    provider_id: str = Field(min_length=1, max_length=100)
    model: str = Field(min_length=1, max_length=200)
    requested_dimensions: Optional[int] = Field(default=None, ge=1, le=4000)
    auto_sync: bool = True


class EmbeddingIndexUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=100)
    auto_sync: Optional[bool] = None


class EmbeddingIndexView(BaseModel):
    embedding_index_id: str
    name: str
    provider_id: str
    model: str
    dimensions: int
    requested_dimensions: Optional[int] = None
    status: Literal["building", "ready", "failed"]
    auto_sync: bool
    chunk_count: int = 0
    pending_message_count: int = 0
    last_error: Optional[str] = None
    active_job_id: Optional[str] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


class EmbeddingSettingsView(BaseModel):
    active_embedding_index_id: Optional[str] = None
    default_chat_provider_id: str = "openai"
    default_chat_model: Optional[str] = None
    indexes: List[EmbeddingIndexView] = Field(default_factory=list)


class ActiveEmbeddingIndexUpdate(BaseModel):
    embedding_index_id: str = Field(min_length=1, max_length=100)


class SourceConversationView(BaseModel):
    source_type: str
    conversation_id: str
    display_name: str
    container_name: Optional[str] = None
    message_count: int = 0


class WhatsAppPreviewMessage(BaseModel):
    author: str
    content: str
    timestamp: Optional[datetime] = None


class WhatsAppImportPreview(BaseModel):
    file_name: str
    text_entry: Optional[str] = None
    detected_date_order: Optional[Literal["DMY", "MDY"]] = None
    requires_date_order: bool = False
    message_count: int
    media_placeholder_count: int = 0
    system_message_count: int = 0
    samples: List[WhatsAppPreviewMessage] = Field(default_factory=list)
    available_text_entries: List[str] = Field(default_factory=list)
    requires_text_entry: bool = False


class WhatsAppImportResponse(BaseModel):
    parsed_count: int
    imported_count: int
    duplicate_count: int
    skipped_count: int
    conversation_id: str
    indexing_job_id: Optional[str] = None


class IntegrationSyncState(BaseModel):
    source_type: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    conversation_id: str
    container_id: Optional[str] = None
    conversation_label: Optional[str] = None
    container_label: Optional[str] = None
    oldest_cursor: Optional[str] = None
    newest_cursor: Optional[str] = None
    active_session_id: Optional[str] = None
    backfill_complete: bool = False
    tracking_enabled: bool = True
    last_error: Optional[str] = None
    raw_message_count: int = 0
    indexed_message_count: int = 0
