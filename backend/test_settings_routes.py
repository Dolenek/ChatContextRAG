from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.models import (
    EmbeddingIndexView, EmbeddingSettingsView, ProviderModelList,
    ProviderProfileView,
)
from backend.settings_routes import register_settings_routes


class FakeSettingsService:
    def __init__(self) -> None:
        self.registry_updates = []

    def list_providers(self):
        return [ProviderProfileView(
            provider_id="openai", name="OpenAI",
            base_url="https://api.openai.com/v1", chat_api="responses",
            has_api_key=True, builtin=True,
        )]

    def replace_custom_providers(self, update):
        self.registry_updates.append(update)
        return self.list_providers()

    def list_models(self, _provider_id):
        return ProviderModelList(models=["chat-model", "embedding-model"])

    def embedding_settings(self):
        return EmbeddingSettingsView(
            active_embedding_index_id="index-1",
            default_chat_model="previous-chat-model", indexes=[self._index()],
        )

    def activate_index(self, _update):
        return self._index()

    @staticmethod
    def _index():
        return EmbeddingIndexView(
            embedding_index_id="index-1", name="Primary", provider_id="openai",
            model="embedding-model", dimensions=1536, status="ready", auto_sync=True,
        )


def test_settings_routes_redact_provider_keys_and_expose_active_index() -> None:
    client, _service = _client()

    providers = client.get("/settings/providers").json()
    embeddings = client.get("/settings/embedding-indexes").json()

    assert providers[0]["has_api_key"] is True
    assert "api_key" not in providers[0]
    assert embeddings["active_embedding_index_id"] == "index-1"
    assert embeddings["default_chat_provider_id"] == "openai"
    assert embeddings["default_chat_model"] == "previous-chat-model"


def test_internal_provider_registry_requires_bootstrap_token() -> None:
    client, service = _client()

    denied = client.put("/internal/provider-registry", json={"providers": []})
    accepted = client.put(
        "/internal/provider-registry", json={"providers": []},
        headers={"X-Chat-Context-Token": "internal-test-token"},
    )

    assert denied.status_code == 403
    assert accepted.status_code == 200
    assert len(service.registry_updates) == 1


def _client():
    application = FastAPI()
    service = FakeSettingsService()
    register_settings_routes(application, service, "internal-test-token")
    return TestClient(application), service
