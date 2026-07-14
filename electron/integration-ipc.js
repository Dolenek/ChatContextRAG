const fs = require("node:fs");
const path = require("node:path");
const { dialog, ipcMain, shell } = require("electron");
const { DiscordBotController } = require("./discord-bot");
const { requireDiscordInviteUrl } = require("./discord-url");

class IntegrationIpcController {
  constructor(options) {
    this.postJson = options.postJson;
    this.getJson = options.getJson;
    this.postMultipart = options.postMultipart;
    this.getMainWindow = options.getMainWindow;
    this.ipcMain = options.ipcMain || ipcMain;
    this.selectedWhatsAppPath = null;
    this.bot = new DiscordBotController({
      api: this.botApi(),
      onProgress: (progress) => this.sendProgress(progress),
    });
  }

  register() {
    this.ipcMain.handle("discord-bot:status", () => this.bot.status());
    this.ipcMain.handle("discord-bot:connect", (_event, token) => this.bot.connect(token));
    this.ipcMain.handle("discord-bot:disconnect", () => this.bot.disconnect());
    this.ipcMain.handle("discord-bot:invite", async () => {
      const url = requireDiscordInviteUrl(this.bot.inviteUrl());
      await shell.openExternal(url);
      return { opened: true };
    });
    this.ipcMain.handle("whatsapp:select", () => this.selectWhatsAppExport());
    this.ipcMain.handle("whatsapp:preview", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp/preview", options));
    this.ipcMain.handle("whatsapp:import", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp", options));
    this.ipcMain.handle("whatsapp:conversations", () =>
      this.getJson("/ingestion/conversations?source_type=whatsapp"));
  }

  botApi() {
    return {
      createSession: (context) => this.postJson("/ingestion/sessions", context),
      importMessages: (sessionId, messages) => this.importMessageBatches(sessionId, messages),
      finishSession: (sessionId, reason) =>
        this.postJson(`/ingestion/sessions/${sessionId}/finish`, { reason }),
      listSyncStates: (sourceType) =>
        this.getJson(`/integrations/sync-states?source_type=${encodeURIComponent(sourceType)}`),
      saveSyncState: (state) => this.postJson("/integrations/sync-state", state),
    };
  }

  async importMessageBatches(sessionId, messages) {
    let latest = null;
    for (let start = 0; start < messages.length; start += 400) {
      latest = await this.postJson("/messages/import", {
        session_id: sessionId, messages: messages.slice(start, start + 400),
      });
    }
    return latest;
  }

  async selectWhatsAppExport() {
    const result = await dialog.showOpenDialog(this.getMainWindow(), {
      properties: ["openFile"],
      filters: [{ name: "WhatsApp export", extensions: ["txt", "zip"] }],
    });
    if (result.canceled || !result.filePaths[0]) return null;
    this.selectedWhatsAppPath = result.filePaths[0];
    return { fileName: path.basename(this.selectedWhatsAppPath) };
  }

  async sendWhatsAppFile(endpoint, options = {}) {
    if (!this.selectedWhatsAppPath) throw new Error("Nejdřív vyberte WhatsApp export.");
    const payload = fs.readFileSync(this.selectedWhatsAppPath);
    const form = new FormData();
    form.append("export_file", new Blob([payload]), path.basename(this.selectedWhatsAppPath));
    for (const [key, value] of Object.entries(options)) {
      if (value !== null && value !== undefined && value !== "") form.append(key, String(value));
    }
    return this.postMultipart(endpoint, form);
  }

  sendProgress(progress) {
    this.getMainWindow()?.webContents.send("discord-bot:progress", progress);
  }

  restoreBot() {
    return this.bot.restore();
  }

  shutdown() {
    return this.bot.shutdown();
  }
}

module.exports = { IntegrationIpcController };
