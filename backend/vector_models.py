from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Optional


@dataclass(frozen=True)
class NormalizedMessage:
    external_id: str
    author: str
    content: str
    timestamp: Optional[datetime]
    channel: Optional[str]


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
