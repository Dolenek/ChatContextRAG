const path = require("node:path");
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");

const { BackendClient } = require("../runtime/backend-client");
const { ArchiveMigrationController } = require("./archive-migration");
const { ArchiveMigrationIpcController } = require("./archive-migration-ipc");
const { ArchiveMigrationStore } = require("./archive-migration-store");
const { BackendProcess, BACKEND_URL } = require("./backend-process");
const { ConnectionIpcController } = require("./connection-ipc");
const { ConnectionStore } = require("./connection-store");
const { DiscordViewController } = require("./discord-view");
const { IntegrationIpcController } = require("./integration-ipc");
const { LocalInfrastructure } = require("./local-infrastructure");
const { ProviderStore } = require("./provider-store");
const { RemoteEventForwarder } = require("./remote-event-forwarder");
const { RemoteIntegrationIpcController } = require("./remote-integration-ipc");
const { RemoteSettingsIpcController } = require("./remote-settings-ipc");
const { SettingsIpcController } = require("./settings-ipc");

const projectRoot = path.resolve(__dirname, "..");
const backendProcess = new BackendProcess(projectRoot, {
  logDirectory: path.join(app.getPath("userData"), "chat-context", "logs"),
});
const localInfrastructure = new LocalInfrastructure(projectRoot);
let activeTarget = { mode: "local" };
let activeDiscordScan = null;
let backendClient;
let discordController;
let integrationController;
let mainWindow;
let remoteEvents;
let sourceMigrationClient;
let settingsController;

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 840,
    minHeight: 620,
    backgroundColor: "#0b1020",
    titleBarStyle: "hiddenInset",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  discordController = new DiscordViewController(mainWindow);
  mainWindow.on("resize", () => discordController.resize());
  await mainWindow.loadFile(path.join(projectRoot, "renderer", "index.html"));
}

function postJson(endpoint, body) {
  return backendClient.post(endpoint, body);
}

function getJson(endpoint) {
  return backendClient.get(endpoint);
}

function deleteJson(endpoint, body) {
  return backendClient.delete(endpoint, body);
}

function patchJson(endpoint, body) {
  return backendClient.patch(endpoint, body);
}

function postMultipart(endpoint, form) {
  return backendClient.multipart(endpoint, form);
}

function registerIpcHandlers() {
  ipcMain.handle("runtime:capabilities", () => runtimeCapabilities());
  ipcMain.handle("discord:open", async () => discordController.open());
  ipcMain.handle("discord:source:open", (_event, source) =>
    discordController.openMessage(source.guild_id, source.channel_id, source.message_id));
  ipcMain.handle("discord:hide", () => discordController.hide());
  ipcMain.handle("discord:capture", captureDiscordMessages);
  ipcMain.handle("discord:scan:start", () => runTrackedDiscordScan(false));
  ipcMain.handle("discord:scan:resume", () => runTrackedDiscordScan(true));
  ipcMain.handle("discord:scan:stop", () => {
    discordController.stopChannelScan();
    return { stopping: true };
  });
  registerDatabaseHandlers();
}

function registerDatabaseHandlers() {
  ipcMain.handle("database:ask", (_event, request) => postJson("/chat", request));
  ipcMain.handle("database:chat-scopes", () => getJson("/chat/scopes"));
  ipcMain.handle("chat-sessions:list", (_event, limit) =>
    getJson(`/chat/sessions?limit=${encodeURIComponent(limit)}`));
  ipcMain.handle("chat-sessions:get", (_event, sessionId) =>
    getJson(`/chat/sessions/${encodeURIComponent(sessionId)}`));
  ipcMain.handle("chat-sessions:rename", (_event, input) =>
    patchJson(`/chat/sessions/${encodeURIComponent(input.sessionId)}`, {
      title: input.title,
    }));
  ipcMain.handle("chat-sessions:delete", (_event, sessionId) =>
    deleteJson(`/chat/sessions/${encodeURIComponent(sessionId)}`));
  ipcMain.handle("database:overview", (_event, pagination) => {
    const parameters = new URLSearchParams(pagination);
    return getJson(`/database/overview?${parameters}`);
  });
  ipcMain.handle("database:clear", (_event, request) => deleteJson("/database", request));
  ipcMain.handle("indexing:retry", (_event, jobId) =>
    postJson(`/indexing/jobs/${jobId}/retry`, {}));
  ipcMain.handle("indexing:cancel", (_event, jobId) =>
    postJson(`/indexing/jobs/${jobId}/cancel`, {}));
  ipcMain.handle("indexing:get", (_event, jobId) => getJson(`/indexing/jobs/${jobId}`));
  ipcMain.handle("indexing:pending", async () => {
    const job = await postJson("/indexing/jobs/pending", {});
    monitorIndexingJob(job.job_id);
    return job;
  });
}

async function captureDiscordMessages() {
  const messages = await discordController.captureVisibleMessages();
  const context = await discordController.getCurrentChannelContext();
  const session = await createIngestionSession(context);
  const result = await postJson("/messages/import", {
    session_id: session.session_id, messages,
  });
  const finished = await finishIngestionSession(session.session_id, "completed");
  monitorIndexingJobs(finished);
  discordController.hide();
  return result;
}

async function runManagedDiscordScan(shouldResume) {
  const context = await discordController.getCurrentChannelContext();
  if (shouldResume) await jumpToResumePoint(context);
  const session = await createIngestionSession(context);
  let summary;
  try {
    summary = await discordController.startChannelScan(
      (messages) => postJson("/messages/import", {
        session_id: session.session_id, messages,
      }),
      (progress) => mainWindow.webContents.send("discord:scan:progress", progress),
    );
  } finally {
    summary = await finishManagedScan(session, summary);
  }
  return summary;
}

async function runTrackedDiscordScan(shouldResume) {
  if (activeDiscordScan) throw new Error("A Discord scan is already running.");
  const operation = runManagedDiscordScan(shouldResume);
  activeDiscordScan = operation;
  try {
    return await operation;
  } finally {
    if (activeDiscordScan === operation) activeDiscordScan = null;
  }
}

async function finishManagedScan(session, summary) {
  const reason = summary?.state === "completed" ? "completed" : "stopped";
  const finished = await finishIngestionSession(session.session_id, reason);
  monitorIndexingJobs(finished);
  if (summary) summary.indexingJobId = finished.indexing_job_id;
  return summary;
}

function createIngestionSession(context) {
  return postJson("/ingestion/sessions", {
    guild_id: context.guildId,
    channel_id: context.channelId,
    channel: context.channel,
  });
}

function finishIngestionSession(sessionId, reason) {
  return postJson(`/ingestion/sessions/${sessionId}/finish`, { reason });
}

async function jumpToResumePoint(context) {
  const parameters = new URLSearchParams({
    channel_id: context.channelId, channel: context.channel,
  });
  const resumePoint = await getJson(`/database/resume-point?${parameters}`);
  if (!resumePoint.message_id) {
    throw new Error("Pro tento kanál zatím v databázi není žádná zpráva.");
  }
  await discordController.jumpToMessage(resumePoint.message_id);
}

async function monitorIndexingJob(jobId) {
  if (!jobId) return;
  try {
    let job;
    do {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      job = await getJson(`/indexing/jobs/${jobId}`);
      mainWindow?.webContents.send("discord:index:progress", job);
    } while (["queued", "running"].includes(job.status));
  } catch (error) {
    console.error("Indexing job monitor failed", error);
  }
}

function monitorIndexingJobs(session) {
  const jobIds = session.indexing_job_ids?.length
    ? session.indexing_job_ids : [session.indexing_job_id].filter(Boolean);
  jobIds.forEach((jobId) => monitorIndexingJob(jobId));
}

function runtimeCapabilities() {
  return {
    mode: activeTarget.mode === "remote" ? "electron-remote" : "electron-local",
    embeddedDiscord: true,
    discordBot: true,
    fileUpload: true,
    migrationExport: activeTarget.mode === "local",
    migrationImport: false,
    migrationProtocolVersion: 1,
  };
}

async function configureLocalRuntime() {
  await localInfrastructure.ensureDatabase();
  await backendProcess.start();
  backendClient = new BackendClient(BACKEND_URL);
  sourceMigrationClient = new BackendClient(BACKEND_URL, {
    "X-Chat-Context-Token": backendProcess.internalToken,
  });
  const providerStore = new ProviderStore(app.getPath("userData"), safeStorage);
  settingsController = new SettingsIpcController(
    providerStore, backendProcess.internalToken, monitorIndexingJob,
  );
  settingsController.register();
  await settingsController.initializeRegistry();
  integrationController = new IntegrationIpcController({
    postJson, getJson, postMultipart, getMainWindow: () => mainWindow,
  });
  integrationController.register();
}

function configureRemoteRuntime(target) {
  sourceMigrationClient = null;
  backendClient = new BackendClient(`${target.baseUrl}/api`, {
    Authorization: `Bearer ${target.token}`,
  });
  settingsController = new RemoteSettingsIpcController(backendClient, monitorIndexingJob);
  settingsController.register();
  integrationController = new RemoteIntegrationIpcController({
    client: backendClient, getMainWindow: () => mainWindow,
  });
  integrationController.register();
  remoteEvents = new RemoteEventForwarder(target.baseUrl, target.token, () => mainWindow);
}

async function createSourceSnapshot() {
  await stopActiveDiscordScan();
  await integrationController.shutdown();
  try {
    const snapshot = await sourceMigrationClient.post("/internal/migration-exports", {});
    const syncStates = await sourceMigrationClient.get(
      "/integrations/sync-states?source_type=discord",
    );
    return { ...snapshot, syncStates };
  } finally {
    await integrationController.restoreBot();
  }
}

async function stopActiveDiscordScan() {
  if (!activeDiscordScan) return;
  discordController.stopChannelScan();
  await activeDiscordScan.catch(() => {});
}

function registerArchiveMigration(connectionStore) {
  const migration = new ArchiveMigrationController({
    sourceClient: sourceMigrationClient,
    connectionStore,
    stateStore: new ArchiveMigrationStore(app.getPath("userData")),
    createRemoteClient: (target) => new BackendClient(`${target.baseUrl}/api`, {
      Authorization: `Bearer ${target.token}`,
    }),
    createSourceSnapshot,
    recoverSourceBackend: (error) => backendProcess.recoverAfterTimeout(error),
    onProgress: (progress) => mainWindow?.webContents.send("migration:progress", progress),
  });
  new ArchiveMigrationIpcController(migration).register();
}

async function initializeApplication() {
  const connectionStore = new ConnectionStore(app.getPath("userData"), safeStorage);
  activeTarget = connectionStore.getActive();
  new ConnectionIpcController({
    store: connectionStore,
    restart: () => setTimeout(() => { app.relaunch(); app.exit(0); }, 100),
  }).register();
  registerIpcHandlers();
  if (activeTarget.mode === "local") await configureLocalRuntime();
  else configureRemoteRuntime(activeTarget);
  registerArchiveMigration(connectionStore);
  await createWindow();
  await integrationController.restoreBot();
  remoteEvents?.start();
}

app.whenReady().then(() => initializeApplication()).catch(async (error) => {
  console.error(error);
  await backendProcess.stop();
  app.exit(1);
});

app.on("window-all-closed", async () => {
  await integrationController?.shutdown();
  remoteEvents?.stop();
  await backendProcess.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});
