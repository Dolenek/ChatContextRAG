from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from backend.database_models import (
    DatabaseBreakdowns, DatabaseChunkPage, DatabaseChunkView, DatabaseCount,
    DatabaseCountPage,
    DatabaseOverview, DatabaseStatus, IndexingJobView,
)
from backend.chat_models import (
    ChatHistoryTurn, ChatRequest, ChatResponse, ChatScope, ChatScopeList,
    ChatScopeOption, ChatSessionDetail, ChatSessionMessage, ChatSessionRename,
    ChatSessionSummary, ChatSource, ChatSourceChunk,
    ChatToolActivity,
    DEFAULT_EVIDENCE_CHARACTER_LIMIT, MAX_EVIDENCE_CHARACTER_LIMIT,
    MIN_EVIDENCE_CHARACTER_LIMIT, ReasoningEffort, RetrievalMode,
)


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


class HealthResponse(BaseModel):
    status: str


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
    summary_ready: bool = True
    summary_generated_at: Optional[datetime] = None
    summary_is_stale: bool = False
    summary_refreshing: bool = False
    summary_error: Optional[str] = None


class EmbeddingSettingsView(BaseModel):
    active_embedding_index_id: Optional[str] = None
    default_chat_provider_id: str = "openai"
    default_chat_model: Optional[str] = None
    indexes: List[EmbeddingIndexView] = Field(default_factory=list)


class ActiveEmbeddingIndexUpdate(BaseModel):
    embedding_index_id: str = Field(min_length=1, max_length=100)


class WorkspaceSettingsView(BaseModel):
    timezone_name: str = Field(min_length=1, max_length=100)


class WorkspaceSettingsUpdate(WorkspaceSettingsView):
    pass


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
