from types import SimpleNamespace

import pytest
from openai import OpenAIError

from backend.models import ProviderProfileInput
from backend.openai_gateway import ExternalIntegrationError, IntegrationConfigurationError
from backend.provider_registry import ProviderRegistry


def test_provider_registry_redacts_keys_and_builds_compatible_clients() -> None:
    registry = ProviderRegistry("openai-secret")
    registry.replace_custom([ProviderProfileInput(
        provider_id="local", name="Local API", base_url="http://localhost:11434/v1/",
        api_key="local-secret", chat_api="chat_completions",
    )])

    views = {view.provider_id: view for view in registry.list_views()}
    chat_provider = registry.create_chat_provider("local", "local-model")

    assert views["local"].has_api_key is True
    assert not hasattr(views["local"], "api_key")
    assert chat_provider.chat_api == "chat_completions"
    assert str(chat_provider.client.base_url) == "http://localhost:11434/v1/"


def test_builtin_openai_provider_remains_available() -> None:
    registry = ProviderRegistry("test-key")

    view = registry.list_views()[0]

    assert view.provider_id == "openai"
    assert view.builtin is True


def test_keyless_local_provider_uses_compatible_client_placeholder() -> None:
    registry = ProviderRegistry("openai-secret")
    registry.replace_custom([ProviderProfileInput(
        provider_id="local", name="Local API", base_url="http://localhost:11434/v1/",
        api_key=None, chat_api="chat_completions",
    )])

    view = {item.provider_id: item for item in registry.list_views()}["local"]
    chat_provider = registry.create_chat_provider("local", "local-model")

    assert view.has_api_key is False
    assert view.is_available is True
    assert chat_provider.client is not None


def test_registry_rejects_builtin_replacement_and_unknown_providers() -> None:
    registry = ProviderRegistry("openai-secret")

    with pytest.raises(ValueError, match="cannot be replaced"):
        registry.replace_custom([ProviderProfileInput(
            provider_id="openai", name="Replacement",
            base_url="https://example.com/v1",
        )])
    with pytest.raises(IntegrationConfigurationError, match="not configured"):
        registry.get("missing")


def test_builtin_provider_requires_its_environment_key_when_used() -> None:
    registry = ProviderRegistry(None)

    view = registry.list_views()[0]

    assert view.is_available is False
    with pytest.raises(IntegrationConfigurationError, match="API key"):
        registry.create_embedding_provider("openai", "embed", 2)


def test_embedding_provider_uses_registry_batch_size() -> None:
    registry = ProviderRegistry("openai-secret", embedding_batch_size=17)

    provider = registry.create_embedding_provider("openai", "embed", 128)

    assert provider.model_name == "embed"
    assert provider.dimensions == 128
    assert provider.batch_size == 17


def test_model_listing_is_sorted_and_deduplicated(monkeypatch) -> None:
    class FakeOpenAI:
        def __init__(self, **kwargs):
            assert kwargs["api_key"] == "openai-secret"

        models = SimpleNamespace(list=lambda: SimpleNamespace(data=[
            SimpleNamespace(id="z-model"), SimpleNamespace(id="a-model"),
            SimpleNamespace(id="a-model"),
        ]))

    monkeypatch.setattr("backend.provider_registry.OpenAI", FakeOpenAI)

    assert ProviderRegistry("openai-secret").list_models("openai") == [
        "a-model", "z-model",
    ]


def test_model_listing_translates_sdk_failures(monkeypatch) -> None:
    class FailingOpenAI:
        def __init__(self, **_kwargs):
            pass

        models = SimpleNamespace(
            list=lambda: (_ for _ in ()).throw(OpenAIError("offline")),
        )

    monkeypatch.setattr("backend.provider_registry.OpenAI", FailingOpenAI)

    with pytest.raises(ExternalIntegrationError, match="Model list request"):
        ProviderRegistry("openai-secret").list_models("openai")
