from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.models import (
    EmbeddingIndexView, EmbeddingSettingsView, IndexingJobView, ProviderModelList,
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

    def create_index(self, _request):
        return self._index()

    def update_index(self, _index_id, _request):
        return self._index()

    def sync_index(self, _index_id):
        return IndexingJobView(
            job_id="job-sync", session_id="session-sync", status="queued",
        )

    def rebuild_index(self, _index_id):
        return self._index()

    def delete_index(self, _index_id):
        return 7

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


def test_provider_models_and_embedding_index_lifecycle_routes() -> None:
    client, _service = _client()

    models = client.get("/settings/providers/openai/models?capability=embedding")
    created = client.post("/settings/embedding-indexes", json={
        "name": "Primary", "provider_id": "openai", "model": "embedding-model",
    })
    updated = client.patch("/settings/embedding-indexes/index-1", json={
        "auto_sync": False,
    })
    activated = client.put("/settings/active-embedding-index", json={
        "embedding_index_id": "index-1",
    })
    synced = client.post("/settings/embedding-indexes/index-1/sync")
    rebuilt = client.post("/settings/embedding-indexes/index-1/rebuild")
    deleted = client.delete("/settings/embedding-indexes/index-1")

    assert models.json()["models"] == ["chat-model", "embedding-model"]
    assert created.json()["embedding_index_id"] == "index-1"
    assert updated.json()["embedding_index_id"] == "index-1"
    assert activated.json()["status"] == "ready"
    assert synced.json()["job_id"] == "job-sync"
    assert rebuilt.json()["embedding_index_id"] == "index-1"
    assert deleted.json() == {"deleted_chunks": 7}


def _client():
    application = FastAPI()
    service = FakeSettingsService()
    register_settings_routes(application, service, "internal-test-token")
    return TestClient(application), service
