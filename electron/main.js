const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, safeStorage } = require("electron");

const { BackendClient } = require("../runtime/backend-client");
const { ArchiveMigrationController } = require("./archive-migration");
const { ArchiveMigrationIpcController } = require("./archive-migration-ipc");
const { ArchiveMigrationStore } = require("./archive-migration-store");
const { BackendProcess, BACKEND_URL } = require("./backend-process");
const { ChatIpcController } = require("./chat-ipc");
const { ConnectionIpcController } = require("./connection-ipc");
const { ConnectionStore } = require("./connection-store");
const { requiresInsecureHttpAcknowledgement } = require("./connection-security");
const { DatabaseIpcController } = require("./database-ipc");
const { DiscordViewController } = require("./discord-view");
const { IntegrationIpcController } = require("./integration-ipc");
const { createTrustedIpcMain } = require("./ipc-security");
const { LocalInfrastructure } = require("./local-infrastructure");
const { ProviderStore } = require("./provider-store");
const { RemoteEventForwarder } = require("./remote-event-forwarder");
const { RemoteIntegrationIpcController } = require("./remote-integration-ipc");
const { RemoteSettingsIpcController } = require("./remote-settings-ipc");
const { SettingsIpcController } = require("./settings-ipc");
const { secureMainWindow } = require("./window-security");

const projectRoot = path.resolve(__dirname, "..");
const rendererFile = path.join(projectRoot, "renderer", "index.html");
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
const trustedIpcMain = createTrustedIpcMain(ipcMain, () => mainWindow, rendererFile);

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
      webviewTag: false,
    },
  });
  secureMainWindow(mainWindow, rendererFile);
  discordController = new DiscordViewController(mainWindow);
  mainWindow.on("resize", () => discordController.resize());
  await mainWindow.loadFile(rendererFile);
}

function postJson(endpoint, body, options = {}) {
  return backendClient.post(endpoint, body, options);
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
  trustedIpcMain.handle("runtime:capabilities", () => runtimeCapabilities());
  trustedIpcMain.handle("discord:open", async () => discordController.open());
  trustedIpcMain.handle("discord:hide", () => discordController.hide());
  trustedIpcMain.handle("discord:capture", captureDiscordMessages);
  trustedIpcMain.handle("discord:scan:start", () => runTrackedDiscordScan(false));
  trustedIpcMain.handle("discord:scan:resume", () => runTrackedDiscordScan(true));
  trustedIpcMain.handle("discord:scan:stop", () => {
    discordController.stopChannelScan();
    return { stopping: true };
  });
  new DatabaseIpcController({
    ipcMain: trustedIpcMain, postJson, getJson, patchJson, deleteJson,
    monitorIndexingJob,
  }).register();
  new ChatIpcController(trustedIpcMain, () => backendClient).register();
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
  backendClient = new BackendClient(BACKEND_URL, {
    "X-Chat-Context-Token": backendProcess.internalToken,
  });
  sourceMigrationClient = new BackendClient(BACKEND_URL, {
    "X-Chat-Context-Token": backendProcess.internalToken,
  });
  const providerStore = new ProviderStore(app.getPath("userData"), safeStorage);
  settingsController = new SettingsIpcController(
    providerStore, backendProcess.internalToken, monitorIndexingJob, trustedIpcMain,
  );
  settingsController.register();
  await settingsController.initializeRegistry();
  integrationController = new IntegrationIpcController({
    postJson, getJson, postMultipart, getMainWindow: () => mainWindow,
    ipcMain: trustedIpcMain,
  });
  integrationController.register();
}

function configureRemoteRuntime(target) {
  sourceMigrationClient = null;
  backendClient = new BackendClient(`${target.baseUrl}/api`, {
    Authorization: `Bearer ${target.token}`,
  });
  settingsController = new RemoteSettingsIpcController(
    backendClient, monitorIndexingJob, trustedIpcMain,
  );
  settingsController.register();
  integrationController = new RemoteIntegrationIpcController({
    client: backendClient, getMainWindow: () => mainWindow, ipcMain: trustedIpcMain,
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
  new ArchiveMigrationIpcController(migration, trustedIpcMain).register();
}

async function initializeApplication() {
  const connectionStore = new ConnectionStore(app.getPath("userData"), safeStorage);
  activeTarget = connectionStore.getActive();
  activeTarget = await acknowledgeLegacyHttpTarget(connectionStore, activeTarget);
  new ConnectionIpcController({
    store: connectionStore,
    restart: () => setTimeout(() => { app.relaunch(); app.exit(0); }, 100),
    ipcMain: trustedIpcMain,
  }).register();
  registerIpcHandlers();
  if (activeTarget.mode === "local") await configureLocalRuntime();
  else configureRemoteRuntime(activeTarget);
  registerArchiveMigration(connectionStore);
  await createWindow();
  await integrationController.restoreBot();
  remoteEvents?.start();
}

async function acknowledgeLegacyHttpTarget(connectionStore, target) {
  if (target.mode !== "remote" || target.insecureHttpAcknowledged
    || !requiresInsecureHttpAcknowledgement(target.baseUrl)) return target;
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "Nešifrované připojení",
    message: "Vzdálený server používá nešifrované HTTP.",
    detail: "Přihlašovací údaje a obsah archivu mohou být na síti odposlechnuty.",
    buttons: ["Povolit pro tento server", "Ukončit aplikaci"],
    defaultId: 1,
    cancelId: 1,
  });
  if (result.response !== 0) throw new Error("Unencrypted remote HTTP was not acknowledged.");
  connectionStore.acknowledgeInsecureOrigin(target.baseUrl);
  return connectionStore.getActive();
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
