from datetime import date
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

from backend.agent_protocol import AgentTool


class SearchArchiveArguments(BaseModel):
    query: str = Field(min_length=2, max_length=1000)
    date_from: Optional[date] = None
    date_to: Optional[date] = None

    @model_validator(mode="after")
    def validate_date_order(self):
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self


class SearchTextArguments(BaseModel):
    patterns: List[str] = Field(min_length=1, max_length=8)
    match_mode: Literal["whole_term", "term_prefix", "token_phrase"]
    operator: Literal["all", "any"]
    sort: Literal["oldest", "newest"]
    limit: int = Field(ge=1, le=20)
    date_from: Optional[date] = None
    date_to: Optional[date] = None

    @field_validator("patterns")
    @classmethod
    def validate_patterns(cls, patterns: List[str]) -> List[str]:
        normalized = [pattern.strip() for pattern in patterns]
        if any(not pattern or len(pattern) > 200 for pattern in normalized):
            raise ValueError("Patterns must contain between 1 and 200 characters.")
        if sum(len(pattern) for pattern in normalized) > 800:
            raise ValueError("Combined pattern length must not exceed 800 characters.")
        return list(dict.fromkeys(normalized))

    @model_validator(mode="after")
    def validate_date_order(self):
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self


class ReadContextArguments(BaseModel):
    evidence_id: str = Field(pattern=r"^E[1-9][0-9]*$")
    before_count: int = Field(ge=0, le=10)
    after_count: int = Field(ge=0, le=10)

    @model_validator(mode="after")
    def require_neighbor(self):
        if self.before_count + self.after_count < 1:
            raise ValueError("At least one neighboring message must be requested.")
        return self


SEARCH_TOOL = AgentTool(
    name="search_archive",
    description=(
        "Search the read-only message archive. Use a standalone semantic query. "
        "For calendar-bounded questions also provide inclusive date_from and date_to "
        "as YYYY-MM-DD; use null for an open side. Scope and timezone are server-owned."
    ),
    parameters={
        "type": "object", "additionalProperties": False,
        "properties": {
            "query": {"type": "string"},
            "date_from": {"type": ["string", "null"], "format": "date"},
            "date_to": {"type": ["string", "null"], "format": "date"},
        },
        "required": ["query", "date_from", "date_to"],
    },
)


TEXT_SEARCH_TOOL = AgentTool(
    name="search_text_occurrences",
    description=(
        "Find direct text occurrences in canonical raw messages. Choose whole_term for "
        "complete tokens, term_prefix for inflected suffixes, or token_phrase for adjacent "
        "tokens. Use oldest/newest for chronology. Scope and timezone are server-owned."
    ),
    parameters={
        "type": "object", "additionalProperties": False,
        "properties": {
            "patterns": {
                "type": "array", "items": {"type": "string"},
                "minItems": 1, "maxItems": 8,
            },
            "match_mode": {
                "type": "string",
                "enum": ["whole_term", "term_prefix", "token_phrase"],
            },
            "operator": {"type": "string", "enum": ["all", "any"]},
            "sort": {"type": "string", "enum": ["oldest", "newest"]},
            "limit": {"type": "integer", "minimum": 1, "maximum": 20},
            "date_from": {"type": ["string", "null"], "format": "date"},
            "date_to": {"type": ["string", "null"], "format": "date"},
        },
        "required": [
            "patterns", "match_mode", "operator", "sort", "limit",
            "date_from", "date_to",
        ],
    },
)


CONTEXT_TOOL = AgentTool(
    name="read_message_context",
    description=(
        "Read neighboring messages around an evidence ID already returned by search. "
        "The server keeps the read inside the evidence scope and time range."
    ),
    parameters={
        "type": "object", "additionalProperties": False,
        "properties": {
            "evidence_id": {"type": "string"},
            "before_count": {"type": "integer"},
            "after_count": {"type": "integer"},
        },
        "required": ["evidence_id", "before_count", "after_count"],
    },
)
