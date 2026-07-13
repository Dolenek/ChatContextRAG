from types import SimpleNamespace

import pytest

from backend.models import (
    ActiveEmbeddingIndexUpdate, EmbeddingIndexCreate, EmbeddingIndexUpdate,
    EmbeddingIndexView, IndexingJobView, ProviderProfileInput,
    ProviderProfileView, ProviderRegistryUpdate,
)
from backend.settings_service import ApplicationSettingsService


def test_provider_replacement_rejects_removal_while_an_index_uses_provider() -> None:
    collaborators = Collaborators()
    collaborators.registry.views.append(_provider_view("local"))
    collaborators.indexes.providers_in_use.add("local")
    service = collaborators.service()

    with pytest.raises(ValueError, match="used by an embedding index"):
        service.replace_custom_providers(ProviderRegistryUpdate(providers=[]))

    assert collaborators.registry.replacements == []


def test_provider_replacement_refreshes_registry_and_wakes_worker() -> None:
    collaborators = Collaborators()
    service = collaborators.service()
    update = ProviderRegistryUpdate(providers=[ProviderProfileInput(
        provider_id="local", name="Local", base_url="http://localhost:11434/v1",
        chat_api="chat_completions",
    )])

    views = service.replace_custom_providers(update)

    assert collaborators.registry.replacements == [update.providers]
    assert collaborators.worker.started == 1
    assert collaborators.worker.woken == 1
    assert views[0].provider_id == "openai"


def test_model_listing_returns_a_warning_instead_of_failing_settings() -> None:
    collaborators = Collaborators()
    collaborators.registry.model_error = RuntimeError("provider offline")

    result = collaborators.service().list_models("local")

    assert result.models == []
    assert "provider offline" in result.warning


def test_embedding_settings_include_environment_chat_defaults() -> None:
    collaborators = Collaborators()
    collaborators.indexes.active_index = _index()

    settings = collaborators.service().embedding_settings()

    assert settings.active_embedding_index_id == "index-1"
    assert settings.default_chat_provider_id == "openai"
    assert settings.default_chat_model == "chat-default"
    assert settings.indexes[0].embedding_index_id == "index-1"


def test_index_lifecycle_coordinates_storage_worker_and_job_views() -> None:
    collaborators = Collaborators()
    service = collaborators.service()

    created = service.create_index(EmbeddingIndexCreate(
        name="Primary", provider_id="openai", model="embed", requested_dimensions=2,
    ))
    updated = service.update_index("index-1", EmbeddingIndexUpdate(auto_sync=False))
    activated = service.activate_index(ActiveEmbeddingIndexUpdate(
        embedding_index_id="index-1",
    ))
    sync_job = service.sync_index("index-1")
    rebuilt = service.rebuild_index("index-1")
    deleted = service.delete_index("index-1")

    assert created.embedding_index_id == "index-1"
    assert collaborators.hybrid.ensured == [("index-1", 2)]
    assert collaborators.indexes.updates[0][0] == "index-1"
    assert activated.embedding_index_id == "index-1"
    assert sync_job.job_id == "job-sync"
    assert rebuilt.active_job_id == "job-rebuild"
    assert collaborators.worker.woken == 3
    assert deleted == 4
    assert collaborators.hybrid.dropped == ["index-1"]


def test_empty_rebuild_marks_index_ready_without_waking_worker() -> None:
    collaborators = Collaborators()
    collaborators.indexes.rebuild_job_id = None

    result = collaborators.service().rebuild_index("index-1")

    assert collaborators.indexes.marked_ready == ["index-1"]
    assert collaborators.worker.woken == 0
    assert result.status == "ready"


def _index(**updates) -> EmbeddingIndexView:
    values = {
        "embedding_index_id": "index-1", "name": "Primary",
        "provider_id": "openai", "model": "embed", "dimensions": 2,
        "requested_dimensions": 2, "status": "ready", "auto_sync": True,
        "active_job_id": None,
    }
    values.update(updates)
    return EmbeddingIndexView(**values)


def _provider_view(provider_id: str) -> ProviderProfileView:
    return ProviderProfileView(
        provider_id=provider_id, name=provider_id, base_url="http://localhost/v1",
        chat_api="chat_completions", has_api_key=False,
    )


class FakeRegistry:
    def __init__(self) -> None:
        self.views = [_provider_view("openai")]
        self.replacements = []
        self.model_error = None

    def list_views(self):
        return self.views

    def replace_custom(self, providers):
        self.replacements.append(providers)

    def list_models(self, _provider_id):
        if self.model_error:
            raise self.model_error
        return ["chat", "embed"]


class FakeIndexes:
    def __init__(self) -> None:
        self.providers_in_use = set()
        self.active_index = None
        self.updates = []
        self.marked_ready = []
        self.rebuild_job_id = "job-rebuild"

    def provider_in_use(self, provider_id):
        return provider_id in self.providers_in_use

    def active(self):
        return self.active_index

    def list(self):
        return [_index(active_job_id="job-rebuild" if self.rebuild_job_id else None)]

    def create(self, _request):
        return _index(status="building", active_job_id="job-create")

    def get(self, _index_id):
        return self.list()[0]

    def update(self, index_id, request):
        self.updates.append((index_id, request))
        return _index(auto_sync=request.auto_sync)

    def activate(self, _index_id):
        return _index()

    def queue_sync(self, _index_id):
        return "job-sync"

    def queue_rebuild(self, _index_id):
        return self.rebuild_job_id

    def mark_ready(self, index_id):
        self.marked_ready.append(index_id)

    def delete(self, _index_id):
        return 4


class FakeHybridRepository:
    def __init__(self) -> None:
        self.ensured = []
        self.dropped = []

    def ensure_model_index(self, index_id, dimensions):
        self.ensured.append((index_id, dimensions))

    def drop_model_index(self, index_id):
        self.dropped.append(index_id)


class FakeWorker:
    def __init__(self) -> None:
        self.started = 0
        self.woken = 0

    def start(self):
        self.started += 1

    def wake(self):
        self.woken += 1


class Collaborators:
    def __init__(self) -> None:
        self.registry = FakeRegistry()
        self.indexes = FakeIndexes()
        self.hybrid = FakeHybridRepository()
        self.worker = FakeWorker()
        self.raw = SimpleNamespace(get_job=lambda job_id: IndexingJobView(
            job_id=job_id, session_id="session-1", status="queued",
        ))

    def service(self) -> ApplicationSettingsService:
        return ApplicationSettingsService(
            self.registry, self.indexes, self.hybrid, self.raw, self.worker,
            default_chat_model="chat-default",
        )
