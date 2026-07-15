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
    this.ipcMain.handle("discord-bot:pause", () =>
      this.client.post("/discord-bot/pause", {}));
    this.ipcMain.handle("discord-bot:resume", () =>
      this.client.post("/discord-bot/resume", {}));
    this.ipcMain.handle("discord-bot:disconnect", () =>
      this.client.post("/discord-bot/disconnect", {}));
    this.ipcMain.handle("discord-bot:invite", () => this.openBotInvite());
    this.registerDiscordSettingsHandlers();
    this.ipcMain.handle("whatsapp:select", () => this.selectWhatsAppExport());
    this.ipcMain.handle("whatsapp:preview", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp/preview", options));
    this.ipcMain.handle("whatsapp:import", (_event, options) =>
      this.sendWhatsAppFile("/imports/whatsapp", options));
    this.ipcMain.handle("whatsapp:conversations", () =>
      this.client.get("/whatsapp/conversations"));
  }

  registerDiscordSettingsHandlers() {
    const answerPath = (answerId) => `/discord-bot/answers/${encodeURIComponent(answerId)}`;
    this.ipcMain.handle("discord-bot:settings", () => this.client.get("/discord-bot/settings"));
    this.ipcMain.handle("discord-bot:model:update", (_event, model) =>
      this.client.put("/discord-bot/settings/model", model));
    this.ipcMain.handle("discord-bot:permissions:update", (_event, permissions) =>
      this.client.put(
        `/discord-bot/guilds/${encodeURIComponent(permissions.guild_id)}/permissions`,
        permissions,
      ));
    this.ipcMain.handle("discord-bot:roles", (_event, guildId) =>
      this.client.get(`/discord-bot/guilds/${encodeURIComponent(guildId)}/roles`));
    this.ipcMain.handle("discord-bot:members", (_event, guildId, query) => this.client.get(
      `/discord-bot/guilds/${encodeURIComponent(guildId)}/members?query=${encodeURIComponent(query)}`,
    ));
    this.ipcMain.handle("discord-bot:subjects", (_event, guildId, subjects) => this.client.post(
      `/discord-bot/guilds/${encodeURIComponent(guildId)}/subjects/availability`,
      { subjects },
    ));
    this.ipcMain.handle("discord-bot:answers", (_event, query = {}) =>
      this.client.get(`/discord-bot/answers?${remoteHistoryQuery(query)}`));
    this.ipcMain.handle("discord-bot:answer", (_event, answerId) =>
      this.client.get(answerPath(answerId)));
    this.ipcMain.handle("discord-bot:answer:delete", (_event, answerId) =>
      this.client.delete(answerPath(answerId)));
    this.ipcMain.handle("discord-bot:answers:delete", (_event, guildId) => this.client.delete(
      `/discord-bot/answers${guildId ? `?guild_id=${encodeURIComponent(guildId)}` : ""}`,
    ));
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

function remoteHistoryQuery(query) {
  const parameters = new URLSearchParams({
    limit: String(query.limit || 25), offset: String(query.offset || 0),
  });
  if (query.guildId) parameters.set("guild_id", query.guildId);
  if (query.channelId) parameters.set("channel_id", query.channelId);
  return parameters.toString();
}

module.exports = { RemoteIntegrationIpcController };
