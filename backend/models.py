from datetime import datetime
from typing import Dict, List, Literal, Optional

from pydantic import BaseModel, Field


class DiscordMessageInput(BaseModel):
    external_id: str = Field(min_length=1, max_length=128)
    author: str = Field(default="Neznámý autor", max_length=200)
    content: str = Field(min_length=1, max_length=10000)
    timestamp: Optional[datetime] = None
    channel: Optional[str] = Field(default=None, max_length=300)


class ImportRequest(BaseModel):
    messages: List[DiscordMessageInput] = Field(min_length=1, max_length=4)


class ImportResponse(BaseModel):
    imported_count: int
    chunk_count: int
    messages: List[DiscordMessageInput]


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


class ClearDatabaseRequest(BaseModel):
    confirmation: Literal["VYMAZAT"]


class ClearDatabaseResponse(BaseModel):
    deleted_chunks: int
