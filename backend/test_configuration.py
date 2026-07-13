import pytest

from backend.settings import ApplicationSettings


def test_application_settings_load_environment_overrides(monkeypatch) -> None:
    values = {
        "POSTGRES_DSN": "postgresql://database/test",
        "OPENAI_API_KEY": "secret",
        "OPENAI_EMBEDDING_MODEL": "embed-v2",
        "OPENAI_EMBEDDING_DIMENSIONS": "768",
        "OPENAI_EMBEDDING_BATCH_SIZE": "32",
        "OPENAI_CHAT_MODEL": "chat-v2",
        "CHAT_CONTEXT_INTERNAL_TOKEN": "internal",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)

    settings = ApplicationSettings.from_environment()

    assert settings.postgres_dsn == "postgresql://database/test"
    assert settings.openai_api_key == "secret"
    assert settings.embedding_model == "embed-v2"
    assert settings.embedding_dimensions == 768
    assert settings.embedding_batch_size == 32
    assert settings.chat_model == "chat-v2"
    assert settings.internal_token == "internal"
    assert settings.require_openai_api_key() == "secret"


def test_application_settings_treat_empty_secrets_as_missing(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "")
    monkeypatch.setenv("CHAT_CONTEXT_INTERNAL_TOKEN", "")

    settings = ApplicationSettings.from_environment()

    assert settings.openai_api_key is None
    assert settings.internal_token is None
    with pytest.raises(ValueError, match="OPENAI_API_KEY"):
        settings.require_openai_api_key()


def test_application_settings_reject_non_numeric_embedding_values(monkeypatch) -> None:
    monkeypatch.setenv("OPENAI_EMBEDDING_DIMENSIONS", "many")

    with pytest.raises(ValueError):
        ApplicationSettings.from_environment()
