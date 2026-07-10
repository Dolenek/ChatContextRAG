from types import SimpleNamespace

from backend.openai_gateway import IntegrationConfigurationError, OpenAIEmbeddingProvider


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
