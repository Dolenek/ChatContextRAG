from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


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


class DatabaseCount(BaseModel):
    label: str
    count: int


class DatabaseCountPage(BaseModel):
    items: List[DatabaseCount] = Field(default_factory=list)
    total: int = 0
    limit: int
    offset: int
    has_more: bool = False
    next_offset: Optional[int] = None


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


class DatabaseStatus(BaseModel):
    total_chunks: int
    total_source_messages: int
    total_channels: int
    total_authors: int
    oldest_message_at: Optional[datetime]
    newest_message_at: Optional[datetime]
    raw_message_count: int = 0
    unique_content_count: int = 0
    duplicate_message_count: int = 0
    indexed_message_count: int = 0
    pending_message_count: int = 0
    database_size: str = "0 bytes"
    indexing_jobs: List[IndexingJobView] = Field(default_factory=list)
    summary_generated_at: Optional[datetime] = None
    summary_is_stale: bool = False
    summary_refreshing: bool = False


class DatabaseBreakdowns(BaseModel):
    channels: List[DatabaseCount] = Field(default_factory=list)
    authors: List[DatabaseCount] = Field(default_factory=list)
    embedding_models: List[DatabaseCount] = Field(default_factory=list)


class DatabaseChunkPage(BaseModel):
    chunks: List[DatabaseChunkView] = Field(default_factory=list)
    has_more: bool = False
    next_cursor: Optional[str] = None


class DatabaseOverview(DatabaseStatus, DatabaseBreakdowns):
    chunks: List[DatabaseChunkView]
    limit: int
    offset: int
    has_more: bool
