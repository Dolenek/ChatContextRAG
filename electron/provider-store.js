const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
]);

class ProviderStore {
  constructor(userDataPath, safeStorage) {
    this.safeStorage = safeStorage;
    this.directory = path.join(userDataPath, "chat-context");
    this.filePath = path.join(this.directory, "provider-profiles.json");
  }

  list() {
    return this._read().providers.map((profile) => this._publicProfile(profile));
  }

  decryptedProfiles() {
    return this._read().providers.map((profile) => ({
      provider_id: profile.providerId,
      name: profile.name,
      base_url: profile.baseUrl,
      chat_api: profile.chatApi,
      api_key: profile.encryptedApiKey
        ? this.safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, "base64"))
        : null,
    }));
  }

  save(input) {
    const state = this._read();
    const existing = state.providers.find((item) => item.providerId === input.providerId);
    const providerId = input.providerId || crypto.randomUUID();
    const apiKey = input.apiKey?.trim();
    const baseUrl = input.baseUrl.trim().replace(/\/$/, "");
    assertBuiltinIdentity(providerId, baseUrl, input.chatApi);
    const profile = {
      providerId,
      name: input.name.trim(),
      baseUrl,
      chatApi: input.chatApi,
      encryptedApiKey: apiKey ? this._encrypt(apiKey) : existing?.encryptedApiKey || null,
    };
    const index = state.providers.findIndex((item) => item.providerId === providerId);
    if (index >= 0) state.providers[index] = profile;
    else state.providers.push(profile);
    this._write(state);
    return this._publicProfile(profile);
  }

  delete(providerId) {
    const state = this._read();
    state.providers = state.providers.filter((item) => item.providerId !== providerId);
    state.chatModels = state.chatModels.filter((model) => model.providerId !== providerId);
    if (state.defaults?.chatProviderId === providerId) {
      state.defaults = null;
    }
    this._write(state);
  }

  getDefaults(fallback = { chatProviderId: "openai", chatModel: "" }) {
    return this._read().defaults || fallback;
  }

  setDefaults(chatProviderId, chatModel) {
    const state = this._read();
    state.defaults = chatProviderId === "openai" && !chatModel
      ? null : { chatProviderId, chatModel };
    this._write(state);
    return state.defaults || { chatProviderId: "openai", chatModel: "" };
  }

  listChatModels(fallbackModels = []) {
    const managedModels = this._read().chatModels.map((model) => ({
      provider_id: model.providerId, model: model.model,
      label: model.label || model.model,
      reasoning_effort: normalizeReasoningEffort(model.reasoningEffort), managed: true,
    }));
    const knownKeys = new Set(managedModels.map(modelKey));
    const fallbackEntries = fallbackModels
      .filter((model) => model?.providerId && model?.model)
      .filter((model) => {
        const key = modelKey({ provider_id: model.providerId, model: model.model });
        if (knownKeys.has(key)) return false;
        knownKeys.add(key);
        return true;
      })
      .map((model) => ({
        provider_id: model.providerId, model: model.model,
        label: model.label || model.model,
        reasoning_effort: normalizeReasoningEffort(model.reasoningEffort), managed: false,
      }));
    return [...managedModels, ...fallbackEntries];
  }

  saveChatModel(input) {
    const state = this._read();
    const providerId = requiredText(input.providerId, "Provider", 100);
    const model = requiredText(input.model, "Model", 200);
    const label = optionalText(input.label, 100) || model;
    const reasoningEffort = normalizeReasoningEffort(input.reasoningEffort);
    const existingIndex = state.chatModels.findIndex(
      (entry) => entry.providerId === providerId && entry.model === model,
    );
    const savedModel = { providerId, model, label, reasoningEffort };
    if (existingIndex >= 0) state.chatModels[existingIndex] = savedModel;
    else if (state.chatModels.length >= 100) throw new Error("Lze uložit nejvýše 100 chat modelů.");
    else state.chatModels.push(savedModel);
    this._write(state);
    return {
      provider_id: providerId, model, label,
      reasoning_effort: reasoningEffort, managed: true,
    };
  }

  deleteChatModel(providerId, model) {
    const state = this._read();
    state.chatModels = state.chatModels.filter(
      (entry) => entry.providerId !== providerId || entry.model !== model,
    );
    this._write(state);
  }

  _encrypt(apiKey) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("Systémové šifrování není dostupné; API klíč nebyl uložen.");
    }
    if (process.platform === "linux"
      && this.safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("Linux secret store není dostupný; plaintext úložiště je zakázané.");
    }
    return this.safeStorage.encryptString(apiKey).toString("base64");
  }

  _read() {
    if (!fs.existsSync(this.filePath)) {
      return { providers: [], defaults: null, chatModels: [] };
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    const defaults = parsed.defaults || null;
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      chatModels: Array.isArray(parsed.chatModels) ? parsed.chatModels : [],
      defaults: defaults?.chatProviderId === "openai" && !defaults.chatModel
        ? null : defaults,
    };
  }

  _write(state) {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  _publicProfile(profile) {
    const builtin = profile.providerId === "openai";
    return {
      provider_id: profile.providerId,
      name: profile.name,
      base_url: profile.baseUrl,
      chat_api: profile.chatApi,
      has_api_key: Boolean(profile.encryptedApiKey),
      is_available: Boolean(profile.encryptedApiKey) || !builtin,
      builtin,
    };
  }
}

function modelKey(model) {
  return `${model.provider_id}\u0000${model.model}`;
}

function requiredText(value, label, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) throw new Error(`${label} je povinný.`);
  if (normalized.length > maxLength) throw new Error(`${label} je příliš dlouhý.`);
  return normalized;
}

function optionalText(value, maxLength) {
  const normalized = String(value || "").trim();
  if (normalized.length > maxLength) throw new Error("Popisek modelu je příliš dlouhý.");
  return normalized;
}

function normalizeReasoningEffort(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized && !REASONING_EFFORTS.has(normalized)) {
    throw new Error("Neplatná úroveň reasoning effort.");
  }
  return normalized || null;
}

function assertBuiltinIdentity(providerId, baseUrl, chatApi) {
  if (providerId !== "openai") return;
  if (baseUrl !== "https://api.openai.com/v1" || chatApi !== "responses") {
    throw new Error("U vestavěného OpenAI lze změnit pouze API klíč.");
  }
}

module.exports = { ProviderStore };
