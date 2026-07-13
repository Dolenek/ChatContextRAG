from backend.models import ProviderProfileInput
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
