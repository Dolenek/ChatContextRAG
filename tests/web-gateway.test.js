const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConnectionStore, normalizeServerUrl } = require("../electron/connection-store");
const { ProviderStore } = require("../electron/provider-store");
const { SseClient } = require("../runtime/sse-client");
const { AesGcmStorage } = require("../web/aes-storage");
const { AuthService } = require("../web/auth");
const { hashPassword } = require("../web/passwords");
const { WebApplication } = require("../web/server");

function testConfig() {
  return {
    adminPasswordHash: hashPassword("correct horse battery staple"),
    adminUsername: "admin",
    apiUrl: "http://unused",
    bindAddress: "127.0.0.1",
    desktopToken: "desktop-token-that-is-long-enough",
    internalToken: "internal-token",
    port: 0,
    projectRoot: path.resolve(__dirname, ".."),
    serverKey: Buffer.alloc(32, 7).toString("base64"),
    sessionHours: 1,
    stateDirectory: os.tmpdir(),
    trustProxy: false,
  };
}

test("AES-GCM storage round-trips secrets and detects tampering", () => {
  const storage = new AesGcmStorage(Buffer.alloc(32, 3).toString("base64"));
  const encrypted = storage.encryptString("provider-secret");

  assert.equal(storage.decryptString(encrypted), "provider-secret");
  encrypted[encrypted.length - 1] ^= 1;
  assert.throws(() => storage.decryptString(encrypted));
});

test("server provider state persists encrypted and returns only redacted metadata", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-provider-"));
  const storage = new AesGcmStorage(Buffer.alloc(32, 4).toString("base64"));
  const providerStore = new ProviderStore(directory, storage);

  const publicProfile = providerStore.save({
    name: "Private provider", baseUrl: "http://model.invalid/v1",
    chatApi: "chat_completions", apiKey: "private-key",
  });

  assert.equal(publicProfile.has_api_key, true);
  assert.equal(JSON.stringify(publicProfile).includes("private-key"), false);
  const persisted = fs.readFileSync(
    path.join(directory, "chat-context", "provider-profiles.json"), "utf8",
  );
  assert.equal(persisted.includes("private-key"), false);
  assert.equal(new ProviderStore(directory, storage).decryptedProfiles()[0].api_key, "private-key");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("SSE client parses complete data frames and retains a partial frame", () => {
  const messages = [];
  const client = new SseClient("http://unused", {}, (message) => messages.push(message));

  const remainder = client.consumeFrames(
    ': heartbeat\n\ndata: {"type":"indexing","payload":{"status":"running"}}\n\ndata: {"type"',
  );

  assert.deepEqual(messages, [{ type: "indexing", payload: { status: "running" } }]);
  assert.equal(remainder, 'data: {"type"');
});

test("admin login is rate limited after repeated failures", () => {
  const auth = new AuthService(testConfig());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.throws(() => auth.login("admin", "wrong-password", "client"));
  }
  assert.throws(
    () => auth.login("admin", "correct horse battery staple", "client"),
    (error) => error.statusCode === 429,
  );
});

test("connection target validates URLs and keeps the token encrypted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-connection-"));
  const safeStorage = reversibleStorage();
  const store = new ConnectionStore(directory, safeStorage);

  store.save({ mode: "remote", baseUrl: "https://server.example/", token: "secret" });

  assert.deepEqual(store.getPublic(), {
    mode: "remote", baseUrl: "https://server.example", hasToken: true,
  });
  assert.equal(store.getActive().token, "secret");
  const persisted = fs.readFileSync(
    path.join(directory, "chat-context", "connection.json"), "utf8",
  );
  assert.equal(persisted.includes("secret"), false);
  assert.throws(() => normalizeServerUrl("file:///tmp/server"));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("gateway protects APIs with session CSRF or desktop bearer authentication", async () => {
  const backend = fakeBackend();
  const application = new WebApplication(testConfig(), {
    backend,
    services: fakeServices(),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const address = application.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const unauthorized = await fetch(`${origin}/api/runtime`);
  assert.equal(unauthorized.status, 401);
  const login = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: "admin", password: "correct horse battery staple" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const sessionResponse = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
  const session = await sessionResponse.json();
  const rejectedMutation = await fetch(`${origin}/api/chat`, {
    method: "POST", headers: { Cookie: cookie, Origin: origin }, body: "{}",
  });
  assert.equal(rejectedMutation.status, 403);
  const acceptedMutation = await fetch(`${origin}/api/chat`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Cookie: cookie, Origin: origin,
      "X-CSRF-Token": session.csrf_token,
    },
    body: JSON.stringify({ question: "hello" }),
  });
  assert.equal(acceptedMutation.status, 200);
  const desktop = await fetch(`${origin}/api/runtime`, {
    headers: { Authorization: "Bearer desktop-token-that-is-long-enough" },
  });
  assert.equal(desktop.status, 200);
  const forbiddenInternalRoute = await fetch(`${origin}/api/internal/provider-registry`, {
    headers: { Authorization: "Bearer desktop-token-that-is-long-enough" },
  });
  assert.equal(forbiddenInternalRoute.status, 404);
  await application.stop();
});

test("renderer loads the runtime bridge before controllers and hides desktop-only controls", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const bridge = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "runtime-bridge.js"), "utf8",
  );
  const styles = fs.readFileSync(path.join(__dirname, "..", "renderer", "styles.css"), "utf8");

  assert.ok(html.indexOf('src="runtime-bridge.js"') < html.indexOf('src="shell-controller.js"'));
  assert.match(bridge, /mode: "web", hasToken: false/);
  assert.match(bridge, /Promise\.resolve\(\{ embedded: false \}\)/);
  assert.match(styles, /\.web-runtime #open-discord-button/);
});

test("web and Electron bridges expose the shared workspace contract", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.js"), "utf8");
  const webBridge = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "runtime-bridge.js"), "utf8",
  );
  const methods = [
    "getRuntimeCapabilities", "getConnectionTarget", "testConnectionTarget",
    "saveConnectionTarget", "openDiscord", "openDiscordSource", "captureDiscord",
    "startDiscordScan", "resumeDiscordScan", "stopDiscordScan", "onDiscordScanProgress",
    "onIndexingProgress", "hideDiscord", "askDatabase", "getChatScopes",
    "getDatabaseOverview", "clearDatabase", "retryIndexingJob", "cancelIndexingJob",
    "getIndexingJob", "indexPendingMessages", "getDiscordBotStatus", "connectDiscordBot",
    "disconnectDiscordBot", "inviteDiscordBot", "onDiscordBotProgress",
    "selectWhatsAppExport", "previewWhatsAppExport", "importWhatsAppExport",
    "getWhatsAppConversations", "getSettings", "saveProvider", "deleteProvider",
    "listProviderModels", "saveChatDefault", "saveChatModel", "deleteChatModel",
    "createEmbeddingIndex", "updateEmbeddingIndex", "activateEmbeddingIndex",
    "syncEmbeddingIndex", "rebuildEmbeddingIndex", "deleteEmbeddingIndex",
  ];

  for (const method of methods) {
    assert.match(preload, new RegExp(`\\b${method}:`), `Electron is missing ${method}`);
    assert.match(webBridge, new RegExp(`\\b${method}(?::|,)`), `Web is missing ${method}`);
  }
});

test("trusted HTTPS proxy produces a Secure browser session cookie", () => {
  const config = { ...testConfig(), trustProxy: true };
  const auth = new AuthService(config);
  const session = auth.createSession();
  const request = {
    headers: { "x-forwarded-proto": "https" }, socket: { encrypted: false },
  };

  assert.match(auth.sessionCookie(session, request), /; Secure$/);
});

function reversibleStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice("encrypted:".length),
  };
}

function fakeBackend() {
  return {
    get: async () => ({ status: "ok" }),
    request: async (_method, route, body) => ({ route, answer: body.question }),
  };
}

function fakeServices() {
  return {
    discord: {
      restore: async () => {}, shutdown: async () => {}, status: () => ({}),
    },
    monitor: { start: () => {}, startSessionJobs: () => {} },
    settings: {},
  };
}
