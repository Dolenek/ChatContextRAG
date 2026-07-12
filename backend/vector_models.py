from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Tuple


@dataclass(frozen=True)
class NormalizedMessage:
    external_id: str
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]
    channel_id: Optional[str]
    guild_id: Optional[str]
    source_type: str = "discord"
    conversation_id: Optional[str] = None
    conversation_label: Optional[str] = None
    container_id: Optional[str] = None
    container_label: Optional[str] = None
    source_metadata: Dict[str, object] = field(default_factory=dict)
    message_order: Optional[int] = None
    related_external_ids: Tuple[str, ...] = ()
    related_timestamps: Tuple[datetime, ...] = ()


@dataclass(frozen=True)
class ConversationChunk:
    chunk_id: str
    content: str
    authors: List[str]
    source_message_ids: List[str]
    channel: Optional[str]
    started_at: Optional[datetime]
    ended_at: Optional[datetime]
    metadata: Dict[str, object]


@dataclass(frozen=True)
class EmbeddedChunk:
    chunk: ConversationChunk
    embedding: List[float]
    embedding_model: str


@dataclass(frozen=True)
class RetrievedChunk:
    content: str
    authors: List[str]
    channel: Optional[str]
    started_at: Optional[datetime]
    similarity_score: float
    source_message_ids: List[str] = field(default_factory=list)
    channel_id: Optional[str] = None
    guild_id: Optional[str] = None
    source_type: str = "discord"
    conversation_id: Optional[str] = None
