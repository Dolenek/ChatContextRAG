const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

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
      api_key: this.safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, "base64")),
    }));
  }

  save(input) {
    const state = this._read();
    const existing = state.providers.find((item) => item.providerId === input.providerId);
    const providerId = input.providerId || crypto.randomUUID();
    const apiKey = input.apiKey?.trim();
    if (!existing && !apiKey) throw new Error("API klíč je povinný pro nový provider profil.");
    const profile = {
      providerId,
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim().replace(/\/$/, ""),
      chatApi: input.chatApi,
      encryptedApiKey: apiKey ? this._encrypt(apiKey) : existing.encryptedApiKey,
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
    if (state.defaults.chatProviderId === providerId) {
      state.defaults = { chatProviderId: "openai", chatModel: "" };
    }
    this._write(state);
  }

  getDefaults() {
    return this._read().defaults;
  }

  setDefaults(chatProviderId, chatModel) {
    const state = this._read();
    state.defaults = { chatProviderId, chatModel };
    this._write(state);
    return state.defaults;
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
      return { providers: [], defaults: { chatProviderId: "openai", chatModel: "" } };
    }
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return {
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
      defaults: parsed.defaults || { chatProviderId: "openai", chatModel: "" },
    };
  }

  _write(state) {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporaryPath, this.filePath);
  }

  _publicProfile(profile) {
    return {
      provider_id: profile.providerId,
      name: profile.name,
      base_url: profile.baseUrl,
      chat_api: profile.chatApi,
      has_api_key: Boolean(profile.encryptedApiKey),
      builtin: false,
    };
  }
}

module.exports = { ProviderStore };
