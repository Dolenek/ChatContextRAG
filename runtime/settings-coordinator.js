class SettingsCoordinator {
  constructor(options) {
    this.providerStore = options.providerStore;
    this.backend = options.backend;
    this.internalToken = options.internalToken;
    this.monitorJob = options.monitorJob || (() => {});
  }

  async initializeRegistry() {
    return this.backend.request("PUT", "/internal/provider-registry", {
      providers: this.providerStore.decryptedProfiles(),
    }, { "X-Chat-Context-Token": this.internalToken });
  }

  async getSettings() {
    const [providers, embeddings, workspace] = await Promise.all([
      this.backend.get("/settings/providers"),
      this.backend.get("/settings/embedding-indexes"),
      this.backend.get("/settings/workspace"),
    ]);
    const environmentDefaults = defaultSelection(embeddings);
    const chatDefaults = this.providerStore.getDefaults(environmentDefaults);
    const chatModels = this.providerStore.listChatModels([
      selectionModel(environmentDefaults), selectionModel(chatDefaults),
    ]);
    return { providers, embeddings, workspace, chatDefaults, chatModels };
  }

  async saveProvider(profile) {
    if (profile.providerId) await this.assertMutableProvider(profile);
    const saved = this.providerStore.save(profile);
    await this.initializeRegistry();
    return saved;
  }

  async deleteProvider(providerId) {
    const settings = await this.getSettings();
    if (settings.embeddings.indexes.some((item) => item.provider_id === providerId)) {
      throw new Error("Provider is used by an embedding index and cannot be deleted.");
    }
    if (settings.chatDefaults.chatProviderId === providerId) {
      throw new Error("Change the default chat provider before deleting it.");
    }
    this.providerStore.delete(providerId);
    await this.initializeRegistry();
    return { deleted: true };
  }

  listProviderModels(providerId) {
    return this.backend.get(
      `/settings/providers/${encodeURIComponent(providerId)}/models`,
    );
  }

  saveChatDefault(providerId, model) {
    return this.providerStore.setDefaults(providerId, model);
  }

  updateWorkspaceSettings(timezoneName) {
    return this.backend.put("/settings/workspace", { timezone_name: timezoneName });
  }

  getWorkspaceSettings() {
    return this.backend.get("/settings/workspace");
  }

  async saveChatModel(model) {
    const settings = await this.getSettings();
    if (!settings.providers.some((item) => item.provider_id === model.providerId)) {
      throw new Error("The selected provider does not exist.");
    }
    const replacesDefault = settings.chatDefaults.chatProviderId === model.originalProviderId
      && settings.chatDefaults.chatModel === model.originalModel;
    return this.providerStore.saveChatModel({ ...model, replaceDefault: replacesDefault });
  }

  deleteChatModel(providerId, model) {
    const defaults = this.providerStore.getDefaults();
    if (defaults.chatProviderId === providerId && defaults.chatModel === model) {
      throw new Error("Select another active model before deleting this one.");
    }
    this.providerStore.deleteChatModel(providerId, model);
    return { deleted: true };
  }

  async createIndex(input) {
    const index = await this.backend.post("/settings/embedding-indexes", input);
    this.monitorJob(index.active_job_id);
    return index;
  }

  updateIndex(indexId, update) {
    return this.backend.patch(`/settings/embedding-indexes/${indexId}`, update);
  }

  activateIndex(indexId) {
    return this.backend.put("/settings/active-embedding-index", {
      embedding_index_id: indexId,
    });
  }

  async syncIndex(indexId) {
    const job = await this.backend.post(`/settings/embedding-indexes/${indexId}/sync`, {});
    this.monitorJob(job.job_id);
    return job;
  }

  async rebuildIndex(indexId) {
    const index = await this.backend.post(
      `/settings/embedding-indexes/${indexId}/rebuild`, {},
    );
    this.monitorJob(index.active_job_id);
    return index;
  }

  deleteIndex(indexId) {
    return this.backend.delete(`/settings/embedding-indexes/${indexId}`);
  }

  async assertMutableProvider(input) {
    const settings = await this.getSettings();
    const existing = settings.providers.find((item) => item.provider_id === input.providerId);
    const inUse = settings.embeddings.indexes.some(
      (item) => item.provider_id === input.providerId,
    );
    if (inUse && existing && providerIdentityChanged(existing, input)) {
      throw new Error("A provider used by an index cannot change its URL or API type.");
    }
  }
}

function defaultSelection(embeddings) {
  return {
    chatProviderId: embeddings.default_chat_provider_id || "openai",
    chatModel: embeddings.default_chat_model || "",
  };
}

function selectionModel(selection) {
  return { providerId: selection.chatProviderId, model: selection.chatModel };
}

function providerIdentityChanged(existing, input) {
  return existing.base_url !== input.baseUrl.replace(/\/$/, "")
    || existing.chat_api !== input.chatApi;
}

module.exports = { SettingsCoordinator };
