from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class DiscordMessageInput(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    author: str = Field(default="Neznámý autor", max_length=200)
    content: str = Field(min_length=1, max_length=10000)
    timestamp: Optional[datetime] = None
    channel: Optional[str] = Field(default=None, max_length=300)
    channel_id: Optional[str] = Field(default=None, max_length=128)
    guild_id: Optional[str] = Field(default=None, max_length=128)


class ImportRequest(BaseModel):
    session_id: Optional[str] = Field(default=None, max_length=64)
    messages: List[DiscordMessageInput] = Field(min_length=1, max_length=400)


class ImportResponse(BaseModel):
    imported_count: int
    chunk_count: int
    messages: List[DiscordMessageInput]
    raw_stored_count: int = 0
    unique_content_count: int = 0


class ChatHistoryTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=10000)


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)
    history: List[ChatHistoryTurn] = Field(default_factory=list, max_length=12)


class ChatSource(BaseModel):
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]
    similarity_score: float
    source_message_ids: List[str] = Field(default_factory=list)
    channel_id: Optional[str] = None
    guild_id: Optional[str] = None


class ChatResponse(BaseModel):
    answer: str
    sources: List[ChatSource]


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
    guild_id: str = Field(min_length=1, max_length=128)
    channel_id: str = Field(min_length=1, max_length=128)
    channel: Optional[str] = Field(default=None, max_length=300)


class IngestionSessionView(BaseModel):
    session_id: str
    status: Literal["running", "completed", "stopped"]
    raw_message_count: int = 0
    indexing_job_id: Optional[str] = None


class FinishIngestionRequest(BaseModel):
    reason: Literal["completed", "stopped"]


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
