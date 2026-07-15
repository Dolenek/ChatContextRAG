const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  BackendClient, DEFAULT_TIMEOUT_MS, parseResponse,
} = require("../runtime/backend-client");
const { SecretStore } = require("../runtime/secret-store");
const { SettingsCoordinator } = require("../runtime/settings-coordinator");
const { SseClient } = require("../runtime/sse-client");
const { ToggleableSecretStore } = require("../runtime/toggleable-secret-store");
const { RemoteEventForwarder } = require("../electron/remote-event-forwarder");

test("backend client serializes JSON, preserves headers, and parses empty responses", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, text: async () => calls.length === 1 ? "" : '{"ok":true}' };
  };
  const client = new BackendClient("https://server.example/", { Authorization: "Bearer token" });

  assert.deepEqual(await client.get("/health"), {});
  assert.deepEqual(await client.post("/messages", { value: 3 }), { ok: true });
  await client.patch("/messages/1", { value: 4 });
  await client.delete("/messages/1", { confirmation: "yes" });
  await client.raw("POST", "/upload", Buffer.from("raw"), { "Content-Type": "text/plain" });

  assert.equal(calls[0].url, "https://server.example/health");
  assert.equal(calls[1].options.headers.Authorization, "Bearer token");
  assert.equal(calls[1].options.headers["Content-Type"], "application/json");
  assert.equal(calls[1].options.body, '{"value":3}');
  assert.equal(calls[4].options.body.toString(), "raw");
  assert.equal(calls[4].options.headers["Content-Type"], "text/plain");
});

test("backend client exposes readable response details and status codes", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({
    ok: false, status: 409, text: async () => "index conflict",
  });

  await assert.rejects(
    new BackendClient("http://unused").put("/index", {}),
    (error) => error.message === "index conflict" && error.statusCode === 409,
  );
  assert.deepEqual(await parseResponse({ text: async () => "" }), {});
});

test("backend client times out within its limit with a concrete local endpoint error", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  const started = Date.now();

  await assert.rejects(
    new BackendClient("http://127.0.0.1:8765", {}, { timeoutMs: 30 }).get("/health"),
    (error) => error.code === "BACKEND_TIMEOUT"
      && error.endpoint === "http://127.0.0.1:8765/health"
      && error.message === "Lokální API neodpovědělo do 30 ms (GET /health).",
  );

  assert.equal(DEFAULT_TIMEOUT_MS, 30_000);
  assert.ok(Date.now() - started < 250);
});

test("backend client accepts caller cancellation independently of its timeout", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(abortError()), { once: true });
  });
  const controller = new AbortController();
  const request = new BackendClient("https://server.example").get(
    "/database/overview", { signal: controller.signal },
  );
  controller.abort();

  await assert.rejects(request, (error) => error.code === "REQUEST_ABORTED");
});

test("secret store encrypts trimmed values, restores them, and clears atomically", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-secret-"));
  const filePath = path.join(directory, "nested", "secret.enc");
  const encryption = reversibleEncryption();
  const store = new SecretStore(filePath, encryption);

  assert.equal(store.load(), null);
  store.save("  private value  ");
  assert.equal(store.load(), "private value");
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  store.clear();
  assert.equal(store.load(), null);
  assert.throws(
    () => new SecretStore(filePath, { isEncryptionAvailable: () => false }).save("x"),
    /unavailable/,
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test("toggleable secret store persists enabled state separately from its secret", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-toggleable-secret-"));
  const stateFile = path.join(directory, "state.json");
  let secret = "encrypted-token";
  const store = new ToggleableSecretStore({
    load: () => secret, save: (value) => { secret = value; }, clear: () => { secret = null; },
  }, stateFile);

  assert.equal(store.isEnabled(), true);
  store.setEnabled(false);
  assert.equal(store.isEnabled(), false);
  assert.equal(store.load(), "encrypted-token");
  store.clear();
  assert.equal(store.load(), null);
  assert.equal(fs.existsSync(stateFile), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("settings coordinator merges environment defaults with managed chat models", async () => {
  const backend = fakeSettingsBackend();
  const providerStore = fakeProviderStore();
  const coordinator = new SettingsCoordinator({ providerStore, backend, internalToken: "internal" });

  const settings = await coordinator.getSettings();
  await coordinator.initializeRegistry();

  assert.deepEqual(settings.chatDefaults, {
    chatProviderId: "openai", chatModel: "environment-chat",
  });
  assert.equal(settings.chatModels[0].model, "environment-chat");
  assert.deepEqual(backend.calls.at(-1), [
    "request", "PUT", "/internal/provider-registry",
    { providers: [{ provider_id: "local" }] },
    { "X-Chat-Context-Token": "internal" },
  ]);
});

test("settings coordinator enforces provider and active-model deletion guards", async () => {
  const backend = fakeSettingsBackend();
  const providerStore = fakeProviderStore();
  const coordinator = new SettingsCoordinator({ providerStore, backend });

  backend.embeddings.indexes = [{ provider_id: "local" }];
  await assert.rejects(coordinator.deleteProvider("local"), /embedding index/);
  backend.embeddings.indexes = [];
  providerStore.defaults = { chatProviderId: "local", chatModel: "chat" };
  await assert.rejects(coordinator.deleteProvider("local"), /default chat provider/);
  assert.throws(() => coordinator.deleteChatModel("local", "chat"), /active model/);
  await assert.rejects(
    coordinator.saveChatModel({ providerId: "missing", model: "chat" }),
    /does not exist/,
  );
});

test("settings coordinator moves the default when editing the active chat model", async () => {
  const backend = fakeSettingsBackend();
  const providerStore = fakeProviderStore();
  providerStore.defaults = { chatProviderId: "local", chatModel: "old-model" };
  const coordinator = new SettingsCoordinator({ providerStore, backend });

  await coordinator.saveChatModel({
    providerId: "local", model: "new-model",
    originalProviderId: "local", originalModel: "old-model",
  });

  assert.equal(providerStore.savedModel.replaceDefault, true);
  assert.equal(providerStore.savedModel.model, "new-model");
});

test("settings coordinator forwards index lifecycle operations and monitors jobs", async () => {
  const backend = fakeSettingsBackend();
  const monitored = [];
  const coordinator = new SettingsCoordinator({
    providerStore: fakeProviderStore(), backend, monitorJob: (jobId) => monitored.push(jobId),
  });

  await coordinator.createIndex({ name: "Primary" });
  await coordinator.updateIndex("index id", { auto_sync: false });
  await coordinator.activateIndex("index id");
  await coordinator.syncIndex("index id");
  await coordinator.rebuildIndex("index id");
  await coordinator.deleteIndex("index id");

  assert.deepEqual(monitored, ["job-create", "job-sync", "job-rebuild"]);
  assert.ok(backend.calls.some((call) => call[0] === "patch" && call[1].includes("index id")));
  assert.ok(backend.calls.some((call) => call[0] === "delete" && call[1].includes("index id")));
});

test("SSE client consumes streamed frames and aborts an active connection", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const messages = [];
  const chunks = [
    Buffer.from('data: {"type":"indexing","payload":{"status":"running"}}\n\n'),
  ];
  global.fetch = async (_url, options) => ({
    ok: true,
    body: { getReader: () => ({ read: async () => chunks.length
      ? { done: false, value: chunks.shift() } : { done: true } }) },
    signal: options.signal,
  });
  const client = new SseClient("http://events", { Authorization: "token" },
    (message) => messages.push(message));
  client.running = true;

  await client.consumeConnection();
  client.stop();

  assert.deepEqual(messages, [{ type: "indexing", payload: { status: "running" } }]);
  assert.equal(client.abortController.signal.aborted, true);
});

test("remote event forwarder maps only supported events to renderer channels", () => {
  const sent = [];
  const forwarder = new RemoteEventForwarder("https://server", "token", () => ({
    webContents: { send: (...arguments) => sent.push(arguments) },
  }));

  forwarder.forward({ type: "indexing", payload: { job_id: "1" } });
  forwarder.forward({ type: "discord-bot", payload: { connected: true } });
  forwarder.forward({ type: "unknown", payload: {} });

  assert.deepEqual(sent, [
    ["discord:index:progress", { job_id: "1" }],
    ["discord-bot:progress", { connected: true }],
  ]);
});

function reversibleEncryption() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice("encrypted:".length),
  };
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function fakeSettingsBackend() {
  return {
    calls: [],
    providers: [
      { provider_id: "openai", base_url: "https://api.openai.com/v1", chat_api: "responses" },
      { provider_id: "local", base_url: "http://localhost/v1", chat_api: "chat_completions" },
    ],
    embeddings: {
      default_chat_provider_id: "openai", default_chat_model: "environment-chat",
      indexes: [],
    },
    async get(pathname) {
      this.calls.push(["get", pathname]);
      return pathname === "/settings/providers" ? this.providers : this.embeddings;
    },
    async request(...arguments) { this.calls.push(["request", ...arguments]); return {}; },
    async post(pathname, body) {
      this.calls.push(["post", pathname, body]);
      if (pathname.endsWith("/sync")) return { job_id: "job-sync" };
      if (pathname.endsWith("/rebuild")) return { active_job_id: "job-rebuild" };
      return { active_job_id: "job-create" };
    },
    async patch(...arguments) { this.calls.push(["patch", ...arguments]); return {}; },
    async put(...arguments) { this.calls.push(["put", ...arguments]); return {}; },
    async delete(...arguments) { this.calls.push(["delete", ...arguments]); return {}; },
  };
}

function fakeProviderStore() {
  return {
    defaults: null, savedModel: null,
    decryptedProfiles: () => [{ provider_id: "local" }],
    getDefaults(fallback = { chatProviderId: "openai", chatModel: "" }) {
      return this.defaults || fallback;
    },
    listChatModels: (models) => models.filter((model) => model.model),
    delete: () => {}, deleteChatModel: () => {},
    saveChatModel(model) { this.savedModel = model; return model; },
  };
}
