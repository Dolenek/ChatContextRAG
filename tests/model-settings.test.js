const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ProviderStore } = require("../electron/provider-store");

test("settings UI is isolated through preload and carries model selection to chat", () => {
  const html = read("renderer/index.html");
  const preload = read("electron/preload.js");
  const settingsUi = read("renderer/settings-ui.js");
  const controller = read("renderer/chat-controller.js");

  assert.match(html, /id="settings-screen"/);
  assert.match(html, /id="chat-model-input"/);
  assert.match(preload, /settings:provider:save/);
  assert.doesNotMatch(preload, /decryptString/);
  assert.match(settingsUi, /saveChatDefault/);
  assert.match(settingsUi, /index\.last_error && !index\.active_job_id/);
  assert.match(controller, /getChatSelection/);
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
