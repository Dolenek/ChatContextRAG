const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");

const { BackendProcess, BACKEND_URL } = require("./backend-process");
const { DiscordViewController } = require("./discord-view");

const projectRoot = path.resolve(__dirname, "..");
const backendProcess = new BackendProcess(projectRoot);
let mainWindow;
let discordController;

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
  const responseBody = await response.json();
  if (!response.ok) {
    throw new Error(responseBody.detail || `Backend vrátil chybu ${response.status}.`);
  }
  return responseBody;
}

function registerIpcHandlers() {
  ipcMain.handle("discord:open", async () => discordController.open());
  ipcMain.handle("discord:hide", () => discordController.hide());
  ipcMain.handle("discord:capture", async () => {
    const messages = await discordController.captureVisibleMessages();
    const result = await postJson("/messages/import", { messages });
    discordController.hide();
    return result;
  });
  ipcMain.handle("database:ask", (_event, request) => postJson("/chat", request));
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  try {
    await backendProcess.start();
    await createWindow();
  } catch (error) {
    console.error(error);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  backendProcess.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) await createWindow();
});
