from dataclasses import dataclass
from typing import Dict, List, Optional, Protocol, Sequence

from backend.chat_models import ChatHistoryTurn, ReasoningEffort


@dataclass(frozen=True)
class AgentTool:
    name: str
    description: str
    parameters: Dict[str, object]


@dataclass(frozen=True)
class AgentToolCall:
    call_id: str
    name: str
    arguments: str


@dataclass(frozen=True)
class AgentToolOutput:
    call_id: str
    output: str


@dataclass(frozen=True)
class AgentTurn:
    text: str
    tool_calls: List[AgentToolCall]


class AgentChatSession(Protocol):
    def next_turn(
        self, tools: Sequence[AgentTool], tool_choice: Optional[str],
        tool_outputs: Sequence[AgentToolOutput] = (),
    ) -> AgentTurn: ...


class AgentChatProvider(Protocol):
    def create_agent_session(
        self, question: str, history: Sequence[ChatHistoryTurn], instructions: str,
        reasoning_effort: Optional[ReasoningEffort], deadline: float,
    ) -> AgentChatSession: ...
