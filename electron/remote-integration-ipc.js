const fs = require("node:fs");
const path = require("node:path");
const { dialog, ipcMain, shell } = require("electron");
const { requireDiscordInviteUrl } = require("./discord-url");

class RemoteIntegrationIpcController {
  constructor(options) {
    this.client = options.client;
    this.getMainWindow = options.getMainWindow;
    this.ipcMain = options.ipcMain || ipcMain;
    this.selectedWhatsAppPath = null;
  }

  register() {
    this.ipcMain.handle("discord-bot:status", () => this.client.get("/discord-bot/status"));
    this.ipcMain.handle("discord-bot:connect", (_event, token) =>
      this.client.post("/discord-bot/connect", { token }));
    this.ipcMain.handle("discord-bot:disconnect", () =>
      this.client.post("/discord-bot/disconnect", {}));
    this.ipcMain.handle("discord-bot:invite", () => this.openBotInvite());
    this.ipcMain.handle("whatsapp:select", () => this.selectWhatsAppExport());
    this.ipcMain.handle("whatsapp:preview", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp/preview", options));
    this.ipcMain.handle("whatsapp:import", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp", options));
    this.ipcMain.handle("whatsapp:conversations", () =>
      this.client.get("/whatsapp/conversations"));
  }

  async openBotInvite() {
    const result = await this.client.get("/discord-bot/invite");
    await shell.openExternal(requireDiscordInviteUrl(result.invite_url));
    return { opened: true };
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
    return this.client.multipart(endpoint, form);
  }

  restoreBot() {}
  shutdown() {}
}

module.exports = { RemoteIntegrationIpcController };
