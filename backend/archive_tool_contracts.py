from datetime import date
from typing import Optional

from pydantic import BaseModel, Field, model_validator

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
