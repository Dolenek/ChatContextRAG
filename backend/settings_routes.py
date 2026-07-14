from fastapi import FastAPI, Header, HTTPException, Query

from backend.api_security import has_valid_internal_token
from backend.models import (
    ActiveEmbeddingIndexUpdate, EmbeddingIndexCreate, EmbeddingIndexUpdate,
    EmbeddingIndexView, EmbeddingSettingsView, IndexingJobView,
    ProviderModelList, ProviderProfileView, ProviderRegistryUpdate,
    WorkspaceSettingsUpdate, WorkspaceSettingsView,
)
from backend.settings_service import ApplicationSettingsService


def register_settings_routes(
    application: FastAPI, service: ApplicationSettingsService,
    internal_token: str,
) -> None:
    _register_provider_routes(application, service, internal_token)
    _register_embedding_routes(application, service)
    _register_embedding_job_routes(application, service)
    _register_workspace_routes(application, service)


def _register_workspace_routes(
    application: FastAPI, service: ApplicationSettingsService,
) -> None:
    @application.get("/settings/workspace", response_model=WorkspaceSettingsView)
    def workspace_settings() -> WorkspaceSettingsView:
        return service.get_workspace_settings()

    @application.put("/settings/workspace", response_model=WorkspaceSettingsView)
    def update_workspace_settings(
        update: WorkspaceSettingsUpdate,
    ) -> WorkspaceSettingsView:
        return service.update_workspace_settings(update)


def _register_provider_routes(
    application: FastAPI, service: ApplicationSettingsService,
    internal_token: str,
) -> None:
    @application.get("/settings/providers", response_model=list[ProviderProfileView])
    def providers() -> list[ProviderProfileView]:
        return service.list_providers()

    @application.put(
        "/internal/provider-registry", response_model=list[ProviderProfileView],
    )
    def update_provider_registry(
        update: ProviderRegistryUpdate,
        x_chat_context_token: str = Header(default=""),
    ) -> list[ProviderProfileView]:
        if not has_valid_internal_token(x_chat_context_token, internal_token):
            raise HTTPException(
                status_code=401, detail="Internal provider registry authorization failed.",
            )
        return service.replace_custom_providers(update)

    @application.get(
        "/settings/providers/{provider_id}/models", response_model=ProviderModelList,
    )
    def provider_models(
        provider_id: str, capability: str = Query(default="chat"),
    ) -> ProviderModelList:
        del capability
        return service.list_models(provider_id)


def _register_embedding_routes(
    application: FastAPI, service: ApplicationSettingsService,
) -> None:

    @application.get("/settings/embedding-indexes", response_model=EmbeddingSettingsView)
    def embedding_indexes() -> EmbeddingSettingsView:
        return service.embedding_settings()

    @application.post("/settings/embedding-indexes", response_model=EmbeddingIndexView)
    def create_embedding_index(request: EmbeddingIndexCreate) -> EmbeddingIndexView:
        return service.create_index(request)

    @application.patch(
        "/settings/embedding-indexes/{index_id}", response_model=EmbeddingIndexView,
    )
    def update_embedding_index(
        index_id: str, request: EmbeddingIndexUpdate,
    ) -> EmbeddingIndexView:
        return service.update_index(index_id, request)

    @application.put(
        "/settings/active-embedding-index", response_model=EmbeddingIndexView,
    )
    def activate_embedding_index(
        request: ActiveEmbeddingIndexUpdate,
    ) -> EmbeddingIndexView:
        return service.activate_index(request)


def _register_embedding_job_routes(
    application: FastAPI, service: ApplicationSettingsService,
) -> None:

    @application.post(
        "/settings/embedding-indexes/{index_id}/sync", response_model=IndexingJobView,
    )
    def sync_embedding_index(index_id: str) -> IndexingJobView:
        return service.sync_index(index_id)

    @application.post(
        "/settings/embedding-indexes/{index_id}/rebuild", response_model=EmbeddingIndexView,
    )
    def rebuild_embedding_index(index_id: str) -> EmbeddingIndexView:
        return service.rebuild_index(index_id)

    @application.delete("/settings/embedding-indexes/{index_id}")
    def delete_embedding_index(index_id: str) -> dict:
        return {"deleted_chunks": service.delete_index(index_id)}
