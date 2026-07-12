const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const { BackendProcess, BACKEND_URL } = require("./backend-process");
const { DiscordViewController } = require("./discord-view");
const { IntegrationIpcController } = require("./integration-ipc");
const { readBackendResponse } = require("./backend-response");

const projectRoot = path.resolve(__dirname, "..");
const backendProcess = new BackendProcess(projectRoot);
let mainWindow;
let discordController;
let integrationController;

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

async function postJson(endpoint, body) {
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await readBackendResponse(response);
  if (!response.ok) {
    throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
  }
  return responseBody;
}

async function getJson(endpoint) {
  const response = await fetch(`${BACKEND_URL}${endpoint}`);
  const responseBody = await readBackendResponse(response);
  if (!response.ok) {
    throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
  }
  return responseBody;
}

async function deleteJson(endpoint, body) {
  const response = await fetch(`${BACKEND_URL}${endpoint}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseBody = await readBackendResponse(response);
  if (!response.ok) {
    throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
  }
  return responseBody;
}

async function postMultipart(endpoint, form) {
  const response = await fetch(`${BACKEND_URL}${endpoint}`, { method: "POST", body: form });
  const responseBody = await readBackendResponse(response);
  if (!response.ok) {
    throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
  }
  return responseBody;
}

function registerIpcHandlers() {
  ipcMain.handle("discord:open", async () => discordController.open());
  ipcMain.handle("discord:source:open", (_event, source) =>
    discordController.openMessage(source.guild_id, source.channel_id, source.message_id));
  ipcMain.handle("discord:hide", () => discordController.hide());
  ipcMain.handle("discord:capture", async () => {
    const messages = await discordController.captureVisibleMessages();
    const context = await discordController.getCurrentChannelContext();
    const session = await createIngestionSession(context);
    const result = await postJson("/messages/import", {
      session_id: session.session_id, messages,
    });
    const finished = await finishIngestionSession(session.session_id, "completed");
    monitorIndexingJob(finished.indexing_job_id);
    discordController.hide();
    return result;
  });
  ipcMain.handle("discord:scan:start", () => runManagedDiscordScan(false));
  ipcMain.handle("discord:scan:resume", () => runManagedDiscordScan(true));
  ipcMain.handle("discord:scan:stop", () => {
    discordController.stopChannelScan();
    return { stopping: true };
  });
  ipcMain.handle("database:ask", (_event, request) => postJson("/chat", request));
  ipcMain.handle("database:chat-scopes", () => getJson("/chat/scopes"));
  ipcMain.handle("database:overview", (_event, pagination) => {
    const parameters = new URLSearchParams(pagination);
    return getJson(`/database/overview?${parameters}`);
  });
  ipcMain.handle("database:clear", (_event, request) => deleteJson("/database", request));
  ipcMain.handle("indexing:retry", (_event, jobId) =>
    postJson(`/indexing/jobs/${jobId}/retry`, {}));
  ipcMain.handle("indexing:cancel", (_event, jobId) =>
    postJson(`/indexing/jobs/${jobId}/cancel`, {}));
  ipcMain.handle("indexing:get", (_event, jobId) =>
    getJson(`/indexing/jobs/${jobId}`));
  ipcMain.handle("indexing:pending", async () => {
    const job = await postJson("/indexing/jobs/pending", {});
    monitorIndexingJob(job.job_id);
    return job;
  });
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
    const reason = summary?.state === "completed" ? "completed" : "stopped";
    const finished = await finishIngestionSession(session.session_id, reason);
    monitorIndexingJob(finished.indexing_job_id);
    if (summary) summary.indexingJobId = finished.indexing_job_id;
  }
  return summary;
}

function createIngestionSession(context) {
  return postJson("/ingestion/sessions", {
    guild_id: context.guildId, channel_id: context.channelId, channel: context.channel,
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

app.whenReady().then(async () => {
  registerIpcHandlers();
  try {
    await backendProcess.start();
    integrationController = new IntegrationIpcController({
      postJson, getJson, postMultipart, getMainWindow: () => mainWindow,
    });
    integrationController.register();
    await createWindow();
    await integrationController.restoreBot();
  } catch (error) {
    console.error(error);
    backendProcess.stop();
    app.exit(1);
  }
});

app.on("window-all-closed", async () => {
  await integrationController?.shutdown();
  backendProcess.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});
