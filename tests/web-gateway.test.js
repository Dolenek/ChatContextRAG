const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { ConnectionStore, normalizeServerUrl } = require("../electron/connection-store");
const { ProviderStore } = require("../electron/provider-store");
const { SseClient } = require("../runtime/sse-client");
const { AesGcmStorage } = require("../web/aes-storage");
const { AuthService, sameOrigin } = require("../web/auth");
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

test("admin login is rate limited after repeated failures", async () => {
  const auth = new AuthService(testConfig());
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(auth.login("admin", "wrong-password", "client"));
  }
  await assert.rejects(
    auth.login("admin", "correct horse battery staple", "client"),
    (error) => error.statusCode === 429,
  );
});

test("trusted proxy login limits use the forwarded client and strict scheme", () => {
  const auth = new AuthService({ ...testConfig(), trustProxy: true });
  const request = {
    headers: {
      host: "archive.example",
      origin: "https://archive.example",
      "x-forwarded-for": "198.51.100.44, 203.0.113.9",
      "x-forwarded-proto": "https",
    },
    socket: { encrypted: false, remoteAddress: "127.0.0.1" },
  };

  assert.equal(auth.clientAddress(request), "203.0.113.9");
  assert.equal(sameOrigin(request, true), true);
  request.headers.origin = "http://archive.example";
  assert.equal(sameOrigin(request, true), false);
});

test("authentication bounds password work, sessions, and source tracking", async () => {
  const passwordCompletions = [];
  const auth = new AuthService(testConfig(), {
    verifyPassword: () => new Promise((resolve) => passwordCompletions.push(resolve)),
    limits: {
      maxConcurrentPasswordVerifications: 2, maxLoginAttempts: 3, maxSessions: 2,
    },
  });
  const firstLogin = auth.login("admin", "password", "client-a");
  const secondLogin = auth.login("admin", "password", "client-b");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(
    auth.login("admin", "password", "client-c"),
    (error) => error.statusCode === 503 && error.retryAfter === 1,
  );
  passwordCompletions.forEach((complete) => complete(false));
  await assert.rejects(firstLogin, (error) => error.statusCode === 401);
  await assert.rejects(secondLogin, (error) => error.statusCode === 401);

  const firstSession = auth.createSession();
  auth.createSession();
  auth.createSession();
  assert.equal(auth.sessions.size, 2);
  assert.equal(auth.sessions.has(firstSession.id), false);
  assert.throws(() => auth.assertRateLimit("client-d"), (error) => error.statusCode === 429);
  assert.equal(auth.loginAttempts.size, 3);
  auth.loginAttempts.values().next().value.resetAt = 0;
  assert.doesNotThrow(() => auth.assertRateLimit("client-d"));
  assert.equal(auth.loginAttempts.size, 3);
});

test("busy authentication responses include Retry-After", async (context) => {
  const busyError = Object.assign(new Error("Authentication service is busy. Try again."), {
    statusCode: 503, retryAfter: 1,
  });
  const application = new WebApplication(testConfig(), {
    auth: { clientAddress: () => "client", login: async () => { throw busyError; } },
    backend: fakeBackend(), services: fakeServices(),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  context.after(() => application.server.close());
  const address = application.server.address();
  const origin = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ username: "admin", password: "password" }),
  });

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
});

test("connection target validates URLs and keeps the token encrypted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-connection-"));
  const safeStorage = reversibleStorage();
  const store = new ConnectionStore(directory, safeStorage);

  store.save({ mode: "remote", baseUrl: "https://server.example/", token: "secret" });

  assert.deepEqual(store.getPublic(), {
    mode: "remote", baseUrl: "https://server.example", hasToken: true,
    insecureHttpAcknowledged: false,
  });
  assert.equal(store.getActive().token, "secret");
  store.save({ mode: "local" });
  store.rememberRemote({ baseUrl: "https://server.example", token: "replacement" });
  assert.equal(store.getPublic().mode, "local");
  assert.equal(store.resolveRemote({ baseUrl: "https://server.example" }).token, "replacement");
  assert.throws(
    () => store.resolveRemote({ baseUrl: "https://other.example" }),
    /token is required/,
  );
  const persisted = fs.readFileSync(
    path.join(directory, "chat-context", "connection.json"), "utf8",
  );
  assert.equal(persisted.includes("secret"), false);
  assert.throws(() => normalizeServerUrl("file:///tmp/server"));
  assert.throws(
    () => store.save({ mode: "remote", baseUrl: "http://archive.example", token: "token" }),
    /explicit acknowledgement/,
  );
  store.save({
    mode: "remote", baseUrl: "http://archive.example", token: "token",
    insecureHttpAcknowledged: true,
  });
  assert.equal(store.getPublic().insecureHttpAcknowledged, true);
  assert.equal(store.getActive().insecureHttpAcknowledged, true);
  assert.throws(
    () => store.resolveRemote({ baseUrl: "http://other.example", token: "token" }),
    /explicit acknowledgement/,
  );
  assert.doesNotThrow(() => store.save({
    mode: "remote", baseUrl: "http://127.0.0.1:8080", token: "token",
  }));
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

  const loginPage = await fetch(`${origin}/login`);
  const publicLogo = await fetch(`${origin}/assets/chat-context-wordmark.png`);
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /chat-context-wordmark\.png/);
  assert.equal(publicLogo.status, 200);
  assert.equal(publicLogo.headers.get("content-type"), "image/png");
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
  const browserMigration = await fetch(`${origin}/api/migrations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json", Cookie: cookie, Origin: origin,
      "X-CSRF-Token": session.csrf_token,
    },
    body: "{}",
  });
  assert.equal(browserMigration.status, 403);
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
  assert.ok(html.indexOf('src="archive-migration-ui.js"') < html.indexOf('src="settings-ui.js"'));
  assert.ok(html.indexOf('src="indexing-api-key-ui.js"') < html.indexOf('src="settings-ui.js"'));
  assert.ok(html.indexOf('src="indexing-job-history-ui.js"') < html.indexOf('src="settings-ui.js"'));
  assert.match(html, /id="archive-migration-start"/);
  assert.match(html, /id="archive-migration-index"/);
  assert.match(html, /id="archive-migration-checkpoint"/);
  assert.match(html, /id="archive-migration-last-batch"/);
  assert.match(html, /id="archive-migration-diagnostic"/);
  assert.match(bridge, /mode: "web", hasToken: false/);
  assert.doesNotMatch(bridge, /openDiscordSource|discord\.com\/channels/);
  assert.match(styles, /\.web-runtime #open-discord-button/);
});

test("web and Electron bridges expose the shared workspace contract", () => {
  const preload = fs.readFileSync(path.join(__dirname, "..", "electron", "preload.js"), "utf8");
  const webBridge = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "runtime-bridge.js"), "utf8",
  );
  const methods = [
    "getRuntimeCapabilities", "getConnectionTarget", "testConnectionTarget",
    "saveConnectionTarget", "inspectArchiveMigration", "startArchiveMigration",
    "pauseArchiveMigration", "resumeArchiveMigration", "getArchiveMigrationStatus",
    "indexArchiveMigration", "forgetArchiveMigration", "onArchiveMigrationProgress",
    "openDiscord", "captureDiscord",
    "startDiscordScan", "resumeDiscordScan", "stopDiscordScan", "onDiscordScanProgress",
    "onIndexingProgress", "hideDiscord", "askDatabase", "askDatabaseStreaming", "getChatScopes",
    "listChatSessions", "getChatSession", "renameChatSession", "deleteChatSession",
    "getDatabaseOverview", "getDatabaseStatus", "getDatabaseBreakdowns",
    "getDatabaseChunkPage", "clearDatabase", "retryIndexingJob", "cancelIndexingJob",
    "getIndexingJob", "indexPendingMessages", "getDiscordBotStatus", "connectDiscordBot",
    "disconnectDiscordBot", "inviteDiscordBot", "onDiscordBotProgress",
    "selectWhatsAppExport", "previewWhatsAppExport", "importWhatsAppExport",
    "getWhatsAppConversations", "getSettings", "saveProvider", "deleteProvider",
    "listProviderModels", "saveChatDefault", "saveChatModel", "deleteChatModel",
    "updateWorkspaceSettings",
    "createEmbeddingIndex", "updateEmbeddingIndex", "activateEmbeddingIndex",
    "syncEmbeddingIndex", "rebuildEmbeddingIndex", "deleteEmbeddingIndex",
  ];

  for (const method of methods) {
    assert.match(preload, new RegExp(`\\b${method}:`), `Electron is missing ${method}`);
    assert.match(webBridge, new RegExp(`\\b${method}(?::|,)`), `Web is missing ${method}`);
  }
  assert.doesNotMatch(preload, /openDiscordSource|discord:source:open/);
  assert.doesNotMatch(webBridge, /openDiscordSource|discord\.com\/channels/);
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
