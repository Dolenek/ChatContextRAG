from typing import List, Optional

from backend.embedding_indexes import PostgresEmbeddingIndexRepository
from backend.hybrid_repository import PostgresHybridRepository
from backend.indexing_worker import PersistentIndexingWorker
from backend.models import (
    ActiveEmbeddingIndexUpdate, EmbeddingIndexCreate, EmbeddingIndexUpdate,
    EmbeddingIndexView, EmbeddingSettingsView, IndexingJobView,
    ProviderModelList, ProviderProfileView, ProviderRegistryUpdate,
    WorkspaceSettingsUpdate, WorkspaceSettingsView,
)
from backend.provider_registry import ProviderRegistry
from backend.raw_repository import PostgresRawMessageRepository


class ApplicationSettingsService:
    def __init__(
        self, registry: ProviderRegistry,
        indexes: PostgresEmbeddingIndexRepository,
        hybrid_repository: PostgresHybridRepository,
        raw_repository: PostgresRawMessageRepository,
        indexing_worker: PersistentIndexingWorker,
        default_chat_provider_id: str = "openai",
        default_chat_model: Optional[str] = None,
        workspace_settings=None,
    ) -> None:
        self.registry = registry
        self.indexes = indexes
        self.hybrid_repository = hybrid_repository
        self.raw_repository = raw_repository
        self.indexing_worker = indexing_worker
        self.default_chat_provider_id = default_chat_provider_id
        self.default_chat_model = default_chat_model
        self.workspace_settings = workspace_settings

    def list_providers(self) -> List[ProviderProfileView]:
        return self.registry.list_views()

    def replace_custom_providers(
        self, update: ProviderRegistryUpdate,
    ) -> List[ProviderProfileView]:
        existing_ids = {item.provider_id for item in update.providers}
        for provider in self.registry.list_views():
            if provider.builtin or provider.provider_id in existing_ids:
                continue
            if self.indexes.provider_in_use(provider.provider_id):
                raise ValueError(
                    f"Provider '{provider.provider_id}' is used by an embedding index."
                )
        self.registry.replace_custom(update.providers)
        self.indexing_worker.start()
        self.indexing_worker.wake()
        return self.list_providers()

    def list_models(self, provider_id: str) -> ProviderModelList:
        try:
            return ProviderModelList(models=self.registry.list_models(provider_id))
        except Exception as error:
            return ProviderModelList(
                models=[], warning=f"Model list is unavailable: {error}",
            )

    def get_workspace_settings(self) -> WorkspaceSettingsView:
        if not self.workspace_settings:
            return WorkspaceSettingsView(timezone_name="UTC")
        return self.workspace_settings.get()

    def update_workspace_settings(
        self, update: WorkspaceSettingsUpdate,
    ) -> WorkspaceSettingsView:
        if not self.workspace_settings:
            raise ValueError("Workspace settings storage is not configured.")
        return self.workspace_settings.update(update)

    def embedding_settings(self) -> EmbeddingSettingsView:
        active = self.indexes.active()
        return EmbeddingSettingsView(
            active_embedding_index_id=(active.embedding_index_id if active else None),
            default_chat_provider_id=self.default_chat_provider_id,
            default_chat_model=self.default_chat_model,
            indexes=self.indexes.list(),
        )

    def create_index(self, request: EmbeddingIndexCreate) -> EmbeddingIndexView:
        view = self.indexes.create(request)
        self.hybrid_repository.ensure_model_index(
            view.embedding_index_id, view.dimensions,
        )
        self.indexing_worker.wake()
        return self.indexes.get(view.embedding_index_id)

    def update_index(
        self, index_id: str, request: EmbeddingIndexUpdate,
    ) -> EmbeddingIndexView:
        return self.indexes.update(index_id, request)

    def activate_index(
        self, update: ActiveEmbeddingIndexUpdate,
    ) -> EmbeddingIndexView:
        return self.indexes.activate(update.embedding_index_id)

    def sync_index(self, index_id: str) -> IndexingJobView:
        job_id = self.indexes.queue_sync(index_id)
        self.indexing_worker.wake()
        return self.raw_repository.get_job(job_id)

    def rebuild_index(self, index_id: str) -> EmbeddingIndexView:
        job_id = self.indexes.queue_rebuild(index_id)
        if job_id:
            self.indexing_worker.wake()
        else:
            self.indexes.mark_ready(index_id)
        return self.indexes.get(index_id)

    def delete_index(self, index_id: str) -> int:
        deleted = self.indexes.delete(index_id)
        self.hybrid_repository.drop_model_index(index_id)
        return deleted
