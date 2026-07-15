const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { ProviderStore } = require("../electron/provider-store");

test("settings UI is isolated through preload and carries model selection to chat", () => {
  const html = read("renderer/index.html");
  const preload = read("electron/preload.js");
  const settingsUi = read("renderer/settings-ui.js");
  const modelSelector = read("renderer/model-selector.js");
  const controller = read("renderer/chat-controller.js");

  assert.match(html, /id="settings-overlay" class="settings-overlay hidden"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /id="chat-model-input"/);
  assert.match(html, /id="chat-model-reasoning-effort"/);
  assert.match(html, /id="cancel-chat-model-edit"/);
  assert.match(html, /id="save-chat-model-button"/);
  assert.match(html, /id="chat-model-trigger"/);
  assert.match(html, /id="indexing-api-key-form"/);
  assert.match(html, /id="indexing-key-provider"/);
  assert.match(html, /id="indexing-api-key"/);
  assert.match(html, /id="indexing-job-history"/);
  assert.ok(
    html.indexOf("Přidat nebo upravit providera") < html.indexOf("<h3>Provideři</h3>"),
    "provider form must appear before the provider list",
  );
  assert.match(preload, /settings:provider:save/);
  assert.match(preload, /settings:chat-model:save/);
  assert.doesNotMatch(preload, /decryptString/);
  assert.match(modelSelector, /saveChatDefault/);
  assert.match(modelSelector, /releaseSessionSelection/);
  assert.match(modelSelector, /model-provider-list/);
  assert.match(settingsUi, /index\.last_error && !index\.active_job_id/);
  assert.match(settingsUi, /refreshReadModel\("all"\)/);
  assert.match(settingsUi, /index\.summary_ready === false \? "—"/);
  assert.match(settingsUi, /Nastavit klíč pro indexing/);
  assert.match(settingsUi, /onClose: resetSettingsDrafts/);
  assert.match(read("renderer/chat-model-settings-ui.js"), /actionButton\("Upravit"/);
  assert.match(read("renderer/chat-model-settings-ui.js"), /originalProviderId/);
  assert.match(read("renderer/indexing-api-key-ui.js"), /saveProvider/);
  assert.match(read("renderer/indexing-job-history-ui.js"), /retryIndexingJob/);
  assert.match(controller, /getChatSelection/);
});

test("managed chat models persist without exposing provider secrets", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-models-"));
  const store = new ProviderStore(directory, {});

  store.saveChatModel({
    providerId: "openai", model: "gpt-test", label: "Testovací model",
    reasoningEffort: "high",
  });
  const models = store.listChatModels([
    { providerId: "openai", model: "environment-model" },
  ]);

  assert.deepEqual(models, [
    {
      provider_id: "openai", model: "gpt-test", label: "Testovací model",
      reasoning_effort: "high", managed: true,
      supports_archive_tools: true, evidence_character_limit: 24000,
    },
    {
      provider_id: "openai", model: "environment-model", label: "environment-model",
      reasoning_effort: null, managed: false,
      supports_archive_tools: true, evidence_character_limit: 24000,
    },
  ]);
  store.deleteChatModel("openai", "gpt-test");
  assert.equal(store.listChatModels().length, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("chat models reject unsupported reasoning effort values", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-reasoning-"));
  const store = new ProviderStore(directory, {});

  assert.throws(() => store.saveChatModel({
    providerId: "openai", model: "gpt-test", reasoningEffort: "extreme",
  }), /reasoning effort/);

  fs.rmSync(directory, { recursive: true, force: true });
});

test("chat model edits replace their original identity and preserve an active default", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-model-edit-"));
  const store = new ProviderStore(directory, {});
  store.saveChatModel({ providerId: "openai", model: "old-model", label: "Old" });
  store.setDefaults("openai", "old-model");

  store.saveChatModel({
    providerId: "openai", model: "new-model", label: "Renamed",
    reasoningEffort: "medium", originalProviderId: "openai",
    originalModel: "old-model", replaceDefault: true,
  });

  assert.deepEqual(store.listChatModels(), [{
    provider_id: "openai", model: "new-model", label: "Renamed",
    reasoning_effort: "medium", managed: true,
    supports_archive_tools: true, evidence_character_limit: 24000,
  }]);
  assert.deepEqual(store.getDefaults(), {
    chatProviderId: "openai", chatModel: "new-model",
  });
  fs.rmSync(directory, { recursive: true, force: true });
});

test("chat model edits reject target identity collisions without changing records", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-model-collision-"));
  const store = new ProviderStore(directory, {});
  store.saveChatModel({ providerId: "openai", model: "first" });
  store.saveChatModel({ providerId: "openai", model: "second" });

  assert.throws(() => store.saveChatModel({
    providerId: "openai", model: "second",
    originalProviderId: "openai", originalModel: "first",
  }), /already exists|už existuje/);
  assert.deepEqual(store.listChatModels().map((model) => model.model), ["first", "second"]);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("keyless local provider remains available for compatible endpoints", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-local-"));
  const store = new ProviderStore(directory, {});
  const view = store.save({
    name: "Local", baseUrl: "http://localhost:11434/v1/",
    apiKey: "", chatApi: "chat_completions",
  });

  assert.equal(view.has_api_key, false);
  assert.equal(view.is_available, true);
  assert.equal(store.decryptedProfiles()[0].api_key, null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("provider store encrypts API keys and never returns them in public profiles", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-provider-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace("encrypted:", ""),
  };
  const store = new ProviderStore(directory, safeStorage);
  const view = store.save({
    name: "Local", baseUrl: "http://localhost:11434/v1/",
    apiKey: "secret", chatApi: "chat_completions",
  });

  assert.equal(view.has_api_key, true);
  assert.equal(view.api_key, undefined);
  assert.equal(store.decryptedProfiles()[0].api_key, "secret");
  assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /"secret"/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("provider store persists an encrypted built-in OpenAI key override", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-openai-key-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().replace("encrypted:", ""),
  };
  const store = new ProviderStore(directory, safeStorage);
  const view = store.save({
    providerId: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1",
    apiKey: "indexing-secret", chatApi: "responses",
  });

  assert.equal(view.builtin, true);
  assert.equal(view.has_api_key, true);
  assert.equal(store.decryptedProfiles()[0].api_key, "indexing-secret");
  assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /indexing-secret/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("indexing API key form saves the selected built-in provider", async () => {
  const form = fakeForm();
  const providerSelect = fakeSelect();
  const apiKeyInput = { value: "indexing-secret", focus: () => {} };
  const elements = new Map([
    ["#indexing-api-key-form", form],
    ["#indexing-key-provider", providerSelect],
    ["#indexing-api-key", apiKeyInput],
  ]);
  const saved = [];
  const context = {
    document: {
      querySelector: (selector) => elements.get(selector),
      createElement: () => ({}),
    },
    window: {
      chatContext: { saveProvider: async (profile) => saved.push(profile) },
      workspaceCache: { invalidate: () => {} },
    },
  };
  vm.runInNewContext(read("renderer/interaction-coordinator.js"), context);
  vm.runInNewContext(read("renderer/indexing-api-key-ui.js"), context);
  context.window.indexingApiKeyUi.bind({ refreshSettings: async () => {}, showToast: () => {} });
  context.window.indexingApiKeyUi.render({
    providers: [{
      provider_id: "openai", name: "OpenAI", base_url: "https://api.openai.com/v1",
      chat_api: "responses", has_api_key: false,
    }],
    embeddings: { active_embedding_index_id: "default", indexes: [{
      embedding_index_id: "default", provider_id: "openai",
    }] },
  });
  providerSelect.value = "openai";

  await form.submit({ preventDefault: () => {} });

  assert.deepEqual(JSON.parse(JSON.stringify(saved[0])), {
    providerId: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1",
    apiKey: "indexing-secret", chatApi: "responses",
  });
  assert.equal(apiKeyInput.value, "");
});

test("provider store keeps environment chat model until an explicit override", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-default-"));
  const store = new ProviderStore(directory, {});
  const environmentDefault = {
    chatProviderId: "openai", chatModel: "previous-chat-model",
  };

  assert.deepEqual(store.getDefaults(environmentDefault), environmentDefault);
  store.setDefaults("custom", "custom-model");
  assert.deepEqual(store.getDefaults(environmentDefault), {
    chatProviderId: "custom", chatModel: "custom-model",
  });

  fs.rmSync(directory, { recursive: true, force: true });
});

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function fakeForm() {
  return {
    addEventListener(name, callback) { if (name === "submit") this.submit = callback; },
    scrollIntoView: () => {},
  };
}

function fakeSelect() {
  return {
    value: "", options: [],
    replaceChildren(...options) { this.options = options; },
  };
}
