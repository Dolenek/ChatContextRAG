from types import SimpleNamespace

from backend.openai_gateway import (
    IntegrationConfigurationError, OpenAIChatCompletionProvider, OpenAIEmbeddingProvider,
)
from backend.models import ChatHistoryTurn


class FakeEmbeddingsEndpoint:
    def __init__(self):
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        items = [
            SimpleNamespace(index=index, embedding=[float(index), 1.0])
            for index, _text in enumerate(kwargs["input"])
        ]
        return SimpleNamespace(data=items)


def test_embedding_provider_batches_inputs() -> None:
    provider = OpenAIEmbeddingProvider("test-key", "test-model", 2, batch_size=2)
    endpoint = FakeEmbeddingsEndpoint()
    provider.client = SimpleNamespace(embeddings=endpoint)

    embeddings = provider.embed_texts(["one", "two", "three"])

    assert len(endpoint.calls) == 2
    assert endpoint.calls[0]["input"] == ["one", "two"]
    assert len(embeddings) == 3


def test_embedding_provider_requires_api_key() -> None:
    provider = OpenAIEmbeddingProvider(None, "test-model", 2)

    try:
        provider.embed_texts(["hello"])
    except IntegrationConfigurationError as error:
        assert "OPENAI_API_KEY" in str(error)
    else:
        raise AssertionError("Expected missing API key error")


def test_embedding_dimensions_are_optional_for_compatible_providers() -> None:
    provider = OpenAIEmbeddingProvider("test-key", "native-model", None)
    endpoint = FakeEmbeddingsEndpoint()
    provider.client = SimpleNamespace(embeddings=endpoint)

    provider.embed_texts(["hello"])

    assert "dimensions" not in endpoint.calls[0]


def test_chat_completions_adapter_uses_system_context() -> None:
    calls = []

    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(choices=[SimpleNamespace(
            message=SimpleNamespace(content="answer"),
        )])

    provider = OpenAIChatCompletionProvider(
        "test-key", "custom-chat", chat_api="chat_completions",
    )
    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=create)),
    )

    answer = provider.answer(
        "question", [ChatHistoryTurn(role="user", content="previous")], [],
    )

    assert answer == "answer"
    assert calls[0]["messages"][0]["role"] == "system"
    assert "reasoning" not in calls[0]
    assert "reasoning_effort" not in calls[0]


def test_chat_completions_adapter_forwards_reasoning_effort() -> None:
    calls = []
    provider = OpenAIChatCompletionProvider(
        "test-key", "reasoning-chat", chat_api="chat_completions",
    )
    provider.client = SimpleNamespace(chat=SimpleNamespace(
        completions=SimpleNamespace(create=lambda **kwargs: (
            calls.append(kwargs) or SimpleNamespace(choices=[SimpleNamespace(
                message=SimpleNamespace(content="answer"),
            )])
        )),
    ))

    provider.answer("question", [], [], "high")

    assert calls[0]["reasoning_effort"] == "high"


def test_responses_adapter_forwards_nested_reasoning_effort() -> None:
    calls = []
    provider = OpenAIChatCompletionProvider("test-key", "reasoning-chat")
    provider.client = SimpleNamespace(responses=SimpleNamespace(
        create=lambda **kwargs: (
            calls.append(kwargs) or SimpleNamespace(output_text="answer")
        ),
    ))

    provider.answer("question", [], [], "medium")

    assert calls[0]["reasoning"] == {"effort": "medium"}


def test_responses_adapter_omits_unspecified_reasoning_effort() -> None:
    calls = []
    provider = OpenAIChatCompletionProvider("test-key", "regular-chat")
    provider.client = SimpleNamespace(responses=SimpleNamespace(
        create=lambda **kwargs: (
            calls.append(kwargs) or SimpleNamespace(output_text="answer")
        ),
    ))

    provider.answer("question", [], [])

    assert "reasoning" not in calls[0]
