import time
from types import SimpleNamespace

import pytest

from backend.adaptive_chat import SEARCH_TOOL
from backend.agent_gateway import (
    AgentProtocolError, ChatCompletionsAgentSession, ResponsesAgentSession,
)
from backend.agent_protocol import AgentToolOutput
from backend.chat_models import ChatHistoryTurn


class FakeResponsesClient:
    def __init__(self, responses):
        self.responses = self
        self.queued = list(responses)
        self.requests = []
        self.options = []

    def with_options(self, **options):
        self.options.append(options)
        return self

    def create(self, **parameters):
        self.requests.append(parameters)
        return self.queued.pop(0)


class FakeChatClient:
    def __init__(self, responses):
        self.chat = SimpleNamespace(completions=self)
        self.queued = list(responses)
        self.requests = []
        self.options = []

    def with_options(self, **options):
        self.options.append(options)
        return self

    def create(self, **parameters):
        self.requests.append(parameters)
        return self.queued.pop(0)


def response_turn(output, text=""):
    return SimpleNamespace(output=output, output_text=text)


def chat_turn(message):
    return SimpleNamespace(choices=[SimpleNamespace(message=message)])


def function_item(call_id="call-1", arguments='{"query":"Alice launch date"}'):
    return SimpleNamespace(
        type="function_call", call_id=call_id,
        name="search_archive", arguments=arguments,
    )


def response_session(client, strict=True):
    return ResponsesAgentSession(
        client, "gpt-test", "follow up",
        [ChatHistoryTurn(role="user", content="Alice planned a launch")],
        "instructions", "high", time.monotonic() + 120, strict,
    )


def chat_session(client, strict=False):
    return ChatCompletionsAgentSession(
        client, "local-test", "follow up",
        [ChatHistoryTurn(role="assistant", content="Alice planned a launch")],
        "instructions", "medium", time.monotonic() + 120, strict,
    )


def test_responses_preserves_calls_and_uses_function_call_outputs():
    call = function_item()
    client = FakeResponsesClient([
        response_turn([call]),
        response_turn([SimpleNamespace(type="message")], "Answer [E1]"),
    ])
    session = response_session(client)

    first = session.next_turn([SEARCH_TOOL], SEARCH_TOOL.name)
    second = session.next_turn([], None, [AgentToolOutput("call-1", '{"messages":[]}')])

    assert first.tool_calls[0].name == "search_archive"
    assert second.text == "Answer [E1]"
    assert client.requests[0]["tool_choice"] == {
        "type": "function", "name": "search_archive",
    }
    assert client.requests[0]["tools"][0]["strict"] is True
    search_schema = client.requests[0]["tools"][0]["parameters"]
    assert search_schema["required"] == ["query", "date_from", "date_to"]
    assert search_schema["properties"]["date_to"]["type"] == ["string", "null"]
    assert client.requests[0]["reasoning"] == {"effort": "high"}
    tool_output = next(
        item for item in client.requests[1]["input"]
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    )
    assert tool_output == {
        "type": "function_call_output", "call_id": "call-1",
        "output": '{"messages":[]}',
    }
    assert "tools" not in client.requests[1]
    assert client.options[0]["max_retries"] == 0


def test_chat_completions_preserves_tool_role_and_non_strict_schema():
    tool_call = SimpleNamespace(
        id="call-2", function=SimpleNamespace(
            name="search_archive", arguments='{"query":"launch"}',
        ),
    )
    assistant_call = SimpleNamespace(content=None, tool_calls=[tool_call])
    final_message = SimpleNamespace(content="Answer", tool_calls=[])
    client = FakeChatClient([chat_turn(assistant_call), chat_turn(final_message)])
    session = chat_session(client)

    session.next_turn([SEARCH_TOOL], SEARCH_TOOL.name)
    final = session.next_turn([], None, [AgentToolOutput("call-2", "{}")])

    tool_definition = client.requests[0]["tools"][0]["function"]
    assert tool_definition["strict"] is False
    assert "additionalProperties" not in tool_definition["parameters"]
    assert tool_definition["parameters"]["required"] == [
        "query", "date_from", "date_to",
    ]
    assert client.requests[0]["tool_choice"] == {
        "type": "function", "function": {"name": "search_archive"},
    }
    assert client.requests[0]["reasoning_effort"] == "medium"
    tool_output = next(
        item for item in client.requests[1]["messages"]
        if isinstance(item, dict) and item.get("role") == "tool"
    )
    assert tool_output == {
        "role": "tool", "tool_call_id": "call-2", "content": "{}",
    }
    assert final.text == "Answer"


@pytest.mark.parametrize("session_factory,client", [
    (response_session, FakeResponsesClient([SimpleNamespace(output=None)])),
    (chat_session, FakeChatClient([SimpleNamespace(choices=[])])),
])
def test_malformed_provider_turn_is_a_protocol_error(session_factory, client):
    with pytest.raises(AgentProtocolError, match="malformed"):
        session_factory(client).next_turn([SEARCH_TOOL], "auto")


def test_expired_deadline_prevents_an_api_call():
    client = FakeResponsesClient([])
    session = ResponsesAgentSession(
        client, "gpt-test", "question", [], "instructions", None,
        time.monotonic() - 1, True,
    )
    with pytest.raises(AgentProtocolError, match="deadline"):
        session.next_turn([SEARCH_TOOL], "auto")
    assert client.requests == []
