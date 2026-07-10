from datetime import datetime
from typing import List, Optional

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
    messages: List[DiscordMessageInput]


class ChatRequest(BaseModel):
    question: str = Field(min_length=2, max_length=2000)


class ChatSource(BaseModel):
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]


class ChatResponse(BaseModel):
    answer: str
    sources: List[ChatSource]


class HealthResponse(BaseModel):
    status: str
