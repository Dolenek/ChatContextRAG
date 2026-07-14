import time
from typing import Optional, Sequence

from openai import OpenAIError

from backend.agent_protocol import (
    AgentChatSession, AgentTool, AgentToolCall, AgentToolOutput, AgentTurn,
)
from backend.chat_models import ChatHistoryTurn, ReasoningEffort


class AgentProtocolError(RuntimeError):
    pass


class OpenAIAgentSessionFactory:
    def __init__(self, client, model_name: str, chat_api: str, strict_tools: bool) -> None:
        self.client = client
        self.model_name = model_name
        self.chat_api = chat_api
        self.strict_tools = strict_tools

    def create(
        self, question: str, history: Sequence[ChatHistoryTurn], instructions: str,
        reasoning_effort: Optional[ReasoningEffort], deadline: float,
    ) -> AgentChatSession:
        arguments = (
            self.client, self.model_name, question, history[-8:], instructions,
            reasoning_effort, deadline, self.strict_tools,
        )
        if self.chat_api == "chat_completions":
            return ChatCompletionsAgentSession(*arguments)
        return ResponsesAgentSession(*arguments)


class BaseAgentSession:
    def __init__(
        self, client, model_name, question, history, instructions,
        reasoning_effort, deadline, strict_tools,
    ) -> None:
        self.client = client
        self.model_name = model_name
        self.question = question
        self.history = history
        self.instructions = instructions
        self.reasoning_effort = reasoning_effort
        self.deadline = deadline
        self.strict_tools = strict_tools

    def _request_client(self):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise AgentProtocolError("Adaptive chat exceeded its 120 second deadline.")
        timeout = min(45.0, remaining)
        if hasattr(self.client, "with_options"):
            return self.client.with_options(timeout=timeout, max_retries=0)
        return self.client

    def _reasoning_parameters(self, responses: bool) -> dict:
        if not self.reasoning_effort:
            return {}
        if responses:
            return {"reasoning": {"effort": self.reasoning_effort}}
        return {"reasoning_effort": self.reasoning_effort}

    def _tool_parameters(self, tool: AgentTool) -> dict:
        if self.strict_tools:
            return tool.parameters
        return {
            key: value for key, value in tool.parameters.items()
            if key != "additionalProperties"
        }


class ResponsesAgentSession(BaseAgentSession):
    def __init__(self, *arguments) -> None:
        super().__init__(*arguments)
        self.input_items = [
            {"role": turn.role, "content": turn.content} for turn in self.history
        ]
        self.input_items.append({"role": "user", "content": self.question})

    def next_turn(self, tools, tool_choice, tool_outputs=()) -> AgentTurn:
        self.input_items.extend(self._tool_outputs(tool_outputs))
        parameters = {
            "model": self.model_name,
            "instructions": self.instructions,
            "input": self.input_items,
            **self._reasoning_parameters(True),
        }
        self._add_tools(parameters, tools, tool_choice)
        try:
            response = self._request_client().responses.create(**parameters)
        except OpenAIError as error:
            raise AgentProtocolError("Responses agent request failed.") from error
        try:
            self.input_items.extend(response.output)
            calls = [
                AgentToolCall(item.call_id, item.name, item.arguments)
                for item in response.output if item.type == "function_call"
            ]
            return AgentTurn(response.output_text or "", calls)
        except (AttributeError, IndexError, TypeError) as error:
            raise AgentProtocolError("Responses provider returned a malformed turn.") from error

    def _add_tools(self, parameters, tools, tool_choice) -> None:
        if not tools:
            return
        parameters["tools"] = [self._tool(tool) for tool in tools]
        parameters["tool_choice"] = self._tool_choice(tool_choice)

    def _tool(self, tool: AgentTool) -> dict:
        return {
            "type": "function", "name": tool.name,
            "description": tool.description, "parameters": self._tool_parameters(tool),
            "strict": self.strict_tools,
        }

    @staticmethod
    def _tool_choice(choice: Optional[str]):
        if choice in {None, "auto", "none", "required"}:
            return choice or "auto"
        return {"type": "function", "name": choice}

    @staticmethod
    def _tool_outputs(outputs):
        return [
            {"type": "function_call_output", "call_id": item.call_id,
             "output": item.output}
            for item in outputs
        ]


class ChatCompletionsAgentSession(BaseAgentSession):
    def __init__(self, *arguments) -> None:
        super().__init__(*arguments)
        self.messages = [{"role": "system", "content": self.instructions}]
        self.messages.extend(
            {"role": turn.role, "content": turn.content} for turn in self.history
        )
        self.messages.append({"role": "user", "content": self.question})

    def next_turn(self, tools, tool_choice, tool_outputs=()) -> AgentTurn:
        self.messages.extend(self._tool_outputs(tool_outputs))
        parameters = {
            "model": self.model_name, "messages": self.messages,
            **self._reasoning_parameters(False),
        }
        self._add_tools(parameters, tools, tool_choice)
        try:
            response = self._request_client().chat.completions.create(**parameters)
        except OpenAIError as error:
            raise AgentProtocolError("Chat Completions agent request failed.") from error
        try:
            message = response.choices[0].message
            self.messages.append(message)
            calls = [
                AgentToolCall(item.id, item.function.name, item.function.arguments)
                for item in (message.tool_calls or [])
            ]
            return AgentTurn(message.content or "", calls)
        except (AttributeError, IndexError, TypeError) as error:
            raise AgentProtocolError(
                "Chat Completions provider returned a malformed turn."
            ) from error

    def _add_tools(self, parameters, tools, tool_choice) -> None:
        if not tools:
            return
        parameters["tools"] = [self._tool(tool) for tool in tools]
        parameters["tool_choice"] = self._tool_choice(tool_choice)

    def _tool(self, tool: AgentTool) -> dict:
        return {"type": "function", "function": {
            "name": tool.name, "description": tool.description,
            "parameters": self._tool_parameters(tool), "strict": self.strict_tools,
        }}

    @staticmethod
    def _tool_choice(choice: Optional[str]):
        if choice in {None, "auto", "none", "required"}:
            return choice or "auto"
        return {"type": "function", "function": {"name": choice}}

    @staticmethod
    def _tool_outputs(outputs):
        return [
            {"role": "tool", "tool_call_id": item.call_id, "content": item.output}
            for item in outputs
        ]
