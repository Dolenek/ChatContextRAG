const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-electron-"));
const handlers = new Map();
const openedUrls = [];
let dialogResult = { canceled: true, filePaths: [] };
let spawnFactory = () => new FakeChildProcess();
const spawnCalls = [];
const electronMock = {
  app: { getPath: () => userDataPath },
  dialog: { showOpenDialog: async () => dialogResult },
  ipcMain: { handle: (name, callback) => handlers.set(name, callback) },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`),
    decryptString: (value) => value.toString().slice("encrypted:".length),
  },
  shell: { openExternal: async (url) => openedUrls.push(url) },
};
const originalLoad = Module._load;
Module._load = function loadWithElectronMocks(request, parent, isMain) {
  if (request === "electron") return electronMock;
  if (request === "node:child_process") {
    return { spawn: (...arguments) => {
      spawnCalls.push(arguments);
      return spawnFactory(...arguments);
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const { BackendProcess } = require("../electron/backend-process");
const { ArchiveMigrationIpcController } = require("../electron/archive-migration-ipc");
const { ConnectionIpcController } = require("../electron/connection-ipc");
const { DiscordBotTokenStore } = require("../electron/discord-bot-token-store");
const { IntegrationIpcController } = require("../electron/integration-ipc");
const { LocalInfrastructure } = require("../electron/local-infrastructure");
const { RemoteIntegrationIpcController } = require("../electron/remote-integration-ipc");
const { RemoteSettingsIpcController } = require("../electron/remote-settings-ipc");
const { SettingsIpcController } = require("../electron/settings-ipc");
Module._load = originalLoad;

test.after(() => fs.rmSync(userDataPath, { recursive: true, force: true }));

test("Discord token store encrypts, restores, and removes the token", () => {
  const store = new DiscordBotTokenStore();

  assert.equal(store.load(), null);
  store.save("  bot-token  ");
  assert.equal(store.load(), "bot-token");
  assert.doesNotMatch(fs.readFileSync(store.filePath, "utf8"), /bot-token$/);
  store.clear();
  assert.equal(store.load(), null);
});

test("connection IPC registers get, test, and save with restart after validation", async () => {
  handlers.clear();
  const calls = [];
  const controller = new ConnectionIpcController({
    store: {
      getPublic: () => ({ mode: "local" }),
      save: (input) => { calls.push(["save", input]); return input; },
    },
    restart: () => calls.push(["restart"]),
  });
  controller.test = async (input) => { calls.push(["test", input]); return { reachable: true }; };
  controller.register();

  assert.deepEqual(await handlers.get("connection:get")(), { mode: "local" });
  const input = { mode: "remote", baseUrl: "https://server", token: "token" };
  assert.deepEqual(await handlers.get("connection:save")(null, input), input);
  assert.deepEqual(calls, [["test", input], ["save", input], ["restart"]]);
});

test("archive migration IPC exposes lifecycle operations", async () => {
  handlers.clear();
  const calls = [];
  const migration = new Proxy({}, {
    get: (_target, method) => async (...arguments) => {
      calls.push([method, ...arguments]);
      return { operation: method };
    },
  });
  new ArchiveMigrationIpcController(migration).register();

  await handlers.get("migration:inspect")(null, { baseUrl: "http://server" });
  await handlers.get("migration:start")(null, { baseUrl: "http://server" });
  await handlers.get("migration:pause")();
  await handlers.get("migration:resume")();
  await handlers.get("migration:status")();
  await handlers.get("migration:index")();
  await handlers.get("migration:forget")();

  assert.deepEqual(calls.map((call) => call[0]), [
    "inspect", "start", "pause", "resume", "getStatus", "index", "forget",
  ]);
});

test("local integration IPC selects and uploads WhatsApp files and opens bot invites", async () => {
  handlers.clear();
  const filePath = path.join(userDataPath, "chat.txt");
  fs.writeFileSync(filePath, "13/7/2026 09:15 - Ada: Hello");
  dialogResult = { canceled: false, filePaths: [filePath] };
  const multipart = [];
  const controller = new IntegrationIpcController({
    postJson: async () => ({}), getJson: async () => [],
    postMultipart: async (...arguments) => { multipart.push(arguments); return { ok: true }; },
    getMainWindow: () => ({ webContents: { send: () => {} } }),
  });
  controller.bot.status = () => ({ connected: false });
  controller.bot.inviteUrl = () => "https://discord.com/oauth2/authorize";
  controller.register();

  assert.deepEqual(await handlers.get("whatsapp:select")(), { fileName: "chat.txt" });
  await handlers.get("whatsapp:preview")(null, { timezone_name: "UTC", empty: "" });
  assert.equal(multipart[0][0], "/imports/whatsapp/preview");
  assert.equal(multipart[0][1].get("timezone_name"), "UTC");
  assert.equal(multipart[0][1].has("empty"), false);
  assert.deepEqual(await handlers.get("discord-bot:invite")(), { opened: true });
  assert.equal(openedUrls.at(-1), "https://discord.com/oauth2/authorize");
});

test("remote integration IPC registers the shared gateway contract", async () => {
  handlers.clear();
  const calls = [];
  const client = {
    get: async (...arguments) => { calls.push(["get", ...arguments]); return { invite_url: "https://invite" }; },
    post: async (...arguments) => { calls.push(["post", ...arguments]); return {}; },
    multipart: async (...arguments) => { calls.push(["multipart", ...arguments]); return {}; },
  };
  const controller = new RemoteIntegrationIpcController({ client, getMainWindow: () => null });
  controller.register();

  await handlers.get("discord-bot:connect")(null, "token");
  await handlers.get("discord-bot:disconnect")();
  assert.deepEqual(calls.slice(0, 2), [
    ["post", "/discord-bot/connect", { token: "token" }],
    ["post", "/discord-bot/disconnect", {}],
  ]);
  assert.equal(handlers.has("whatsapp:import"), true);
  assert.equal(handlers.has("whatsapp:conversations"), true);
});

test("local settings IPC registers lifecycle handlers and monitors returned jobs", async () => {
  handlers.clear();
  const monitored = [];
  const controller = new SettingsIpcController({
    setDefaults: (...arguments) => ({ arguments }),
  }, "internal", (jobId) => monitored.push(jobId));
  controller.getSettings = async () => ({ providers: [] });
  controller.request = async (_method, pathname) => {
    if (pathname.endsWith("/sync")) return { job_id: "job-sync" };
    if (pathname.endsWith("/rebuild")) return { active_job_id: "job-rebuild" };
    return { active_job_id: "job-create" };
  };
  controller.register();

  await handlers.get("settings:index:create")(null, {});
  await handlers.get("settings:index:sync")(null, "index-1");
  await handlers.get("settings:index:rebuild")(null, "index-1");
  assert.deepEqual(monitored, ["job-create", "job-sync", "job-rebuild"]);
  assert.deepEqual(await handlers.get("settings:get")(), { providers: [] });
});

test("remote settings IPC forwards every settings operation and monitors jobs", async () => {
  handlers.clear();
  const calls = [];
  const monitored = [];
  const client = new Proxy({}, {
    get: (_target, method) => async (...arguments) => {
      calls.push([method, ...arguments]);
      if (String(arguments[0]).endsWith("/sync")) return { job_id: "job-sync" };
      if (String(arguments[0]).endsWith("/rebuild")) return { active_job_id: "job-rebuild" };
      return {};
    },
  });
  new RemoteSettingsIpcController(client, (jobId) => monitored.push(jobId)).register();

  await handlers.get("settings:provider:save")(null, { name: "Local" });
  await handlers.get("settings:index:activate")(null, "index-1");
  await handlers.get("settings:index:sync")(null, "index-1");
  await handlers.get("settings:index:rebuild")(null, "index-1");
  assert.deepEqual(monitored, ["job-sync", "job-rebuild"]);
  assert.deepEqual(calls[1], ["put", "/settings/active-embedding-index", { indexId: "index-1" }]);
});

test("local infrastructure reports Docker success and captured failure output", async () => {
  spawnFactory = () => {
    const child = new FakeChildProcess();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  await new LocalInfrastructure("C:/project").ensureDatabase();
  assert.deepEqual(spawnCalls.at(-1)[1].slice(0, 3), ["compose", "up", "-d"]);

  spawnFactory = () => {
    const child = new FakeChildProcess();
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("database unavailable"));
      child.emit("exit", 1);
    });
    return child;
  };
  await assert.rejects(
    new LocalInfrastructure("C:/project").ensureDatabase(),
    /exit 1.*database unavailable/s,
  );
});

test("backend process skips spawning when healthy and stops a running child", async () => {
  const backend = new BackendProcess("C:/project");
  let spawned = 0;
  backend.isHealthy = async () => true;
  backend.spawnPythonService = () => { spawned += 1; return new FakeChildProcess(); };
  await backend.start();
  assert.equal(spawned, 0);

  const child = new FakeChildProcess();
  backend.process = child;
  backend.stop();
  assert.equal(child.killed, true);
});

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.killed = false;
  }
  kill() { this.killed = true; }
}
