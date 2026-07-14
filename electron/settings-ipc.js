const { ipcMain } = require("electron");

const { BACKEND_URL } = require("./backend-process");
const { readBackendResponse } = require("./backend-response");

class SettingsIpcController {
  constructor(providerStore, internalToken, monitorJob) {
    this.providerStore = providerStore;
    this.internalToken = internalToken;
    this.monitorJob = monitorJob;
  }

  register() {
    ipcMain.handle("settings:get", () => this.getSettings());
    ipcMain.handle("settings:provider:save", (_event, profile) => this.saveProvider(profile));
    ipcMain.handle("settings:provider:delete", (_event, providerId) =>
      this.deleteProvider(providerId));
    ipcMain.handle("settings:models", (_event, providerId) =>
      this.request("GET", `/settings/providers/${encodeURIComponent(providerId)}/models`));
    ipcMain.handle("settings:chat-default", (_event, selection) =>
      this.providerStore.setDefaults(selection.providerId, selection.model));
    ipcMain.handle("settings:chat-model:save", (_event, model) =>
      this.saveChatModel(model));
    ipcMain.handle("settings:chat-model:delete", (_event, model) =>
      this.deleteChatModel(model));
    ipcMain.handle("settings:index:create", async (_event, input) => {
      const index = await this.request("POST", "/settings/embedding-indexes", input);
      this.monitorJob(index.active_job_id);
      return index;
    });
    ipcMain.handle("settings:index:update", (_event, input) =>
      this.request("PATCH", `/settings/embedding-indexes/${input.indexId}`, input.update));
    ipcMain.handle("settings:index:activate", (_event, indexId) =>
      this.request("PUT", "/settings/active-embedding-index", {
        embedding_index_id: indexId,
      }));
    ipcMain.handle("settings:index:sync", async (_event, indexId) => {
      const job = await this.request("POST", `/settings/embedding-indexes/${indexId}/sync`, {});
      this.monitorJob(job.job_id);
      return job;
    });
    ipcMain.handle("settings:index:rebuild", async (_event, indexId) => {
      const index = await this.request(
        "POST", `/settings/embedding-indexes/${indexId}/rebuild`, {},
      );
      this.monitorJob(index.active_job_id);
      return index;
    });
    ipcMain.handle("settings:index:delete", (_event, indexId) =>
      this.request("DELETE", `/settings/embedding-indexes/${indexId}`));
  }

  async initializeRegistry() {
    await this.request("PUT", "/internal/provider-registry", {
      providers: this.providerStore.decryptedProfiles(),
    }, { "X-Chat-Context-Token": this.internalToken });
  }

  async getSettings() {
    const [providers, embeddings] = await Promise.all([
      this.request("GET", "/settings/providers"),
      this.request("GET", "/settings/embedding-indexes"),
    ]);
    const environmentDefaults = {
      chatProviderId: embeddings.default_chat_provider_id || "openai",
      chatModel: embeddings.default_chat_model || "",
    };
    const chatDefaults = this.providerStore.getDefaults(environmentDefaults);
    const chatModels = this.providerStore.listChatModels([
      { providerId: environmentDefaults.chatProviderId, model: environmentDefaults.chatModel },
      { providerId: chatDefaults.chatProviderId, model: chatDefaults.chatModel },
    ]);
    return { providers, embeddings, chatDefaults, chatModels };
  }

  async saveProvider(profile) {
    if (profile.providerId) await this._assertMutableProvider(profile);
    const saved = this.providerStore.save(profile);
    await this.initializeRegistry();
    return saved;
  }

  async deleteProvider(providerId) {
    const settings = await this.getSettings();
    if (settings.embeddings.indexes.some((item) => item.provider_id === providerId)) {
      throw new Error("Provider používá embedding index a nelze jej smazat.");
    }
    if (settings.chatDefaults.chatProviderId === providerId) {
      throw new Error("Nejdřív změňte výchozí chat provider.");
    }
    this.providerStore.delete(providerId);
    await this.initializeRegistry();
    return { deleted: true };
  }

  async saveChatModel(model) {
    const settings = await this.getSettings();
    if (!settings.providers.some((provider) => provider.provider_id === model.providerId)) {
      throw new Error("Vybraný provider neexistuje.");
    }
    const replacesDefault = settings.chatDefaults.chatProviderId === model.originalProviderId
      && settings.chatDefaults.chatModel === model.originalModel;
    return this.providerStore.saveChatModel({ ...model, replaceDefault: replacesDefault });
  }

  async deleteChatModel(model) {
    const defaults = this.providerStore.getDefaults();
    if (defaults.chatProviderId === model.providerId && defaults.chatModel === model.model) {
      throw new Error("Aktivní chat model nelze smazat. Nejdřív vyberte jiný model.");
    }
    this.providerStore.deleteChatModel(model.providerId, model.model);
    return { deleted: true };
  }

  async _assertMutableProvider(input) {
    const settings = await this.getSettings();
    const existing = settings.providers.find((item) => item.provider_id === input.providerId);
    const inUse = settings.embeddings.indexes.some(
      (item) => item.provider_id === input.providerId,
    );
    if (inUse && existing
      && (existing.base_url !== input.baseUrl.replace(/\/$/, "")
        || existing.chat_api !== input.chatApi)) {
      throw new Error("Base URL ani typ API nelze změnit u provideru používaného indexem.");
    }
  }

  async request(method, endpoint, body, extraHeaders = {}) {
    const options = { method, headers: { ...extraHeaders } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(`${BACKEND_URL}${endpoint}`, options);
    const responseBody = await readBackendResponse(response);
    if (!response.ok) {
      throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
    }
    return responseBody;
  }
}

module.exports = { SettingsIpcController };
