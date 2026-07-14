const fs = require("node:fs");
const path = require("node:path");
const { dialog, ipcMain, shell } = require("electron");
const { DiscordBotController } = require("./discord-bot");
const { requireDiscordInviteUrl } = require("./discord-url");

class IntegrationIpcController {
  constructor(options) {
    this.postJson = options.postJson;
    this.getJson = options.getJson;
    this.putJson = options.putJson;
    this.patchJson = options.patchJson;
    this.deleteJson = options.deleteJson;
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
    this.registerDiscordSettingsHandlers();
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
      getDiscordBotSettings: () => this.getJson("/integrations/discord-bot/settings"),
      updateDiscordBotModel: (model) =>
        this.putJson("/integrations/discord-bot/settings/model", model),
      updateDiscordGuildPermissions: (permissions) => this.putJson(
        `/integrations/discord-bot/guilds/${encodeURIComponent(permissions.guild_id)}/permissions`,
        permissions,
      ),
      answerDiscordQuestion: (request) =>
        this.postJson("/integrations/discord-bot/answers", request, { timeoutMs: 130_000 }),
      recordDiscordAnswerDelivery: (answerId, update) => this.patchJson(
        `/integrations/discord-bot/answers/${encodeURIComponent(answerId)}/delivery`, update,
      ),
    };
  }

  registerDiscordSettingsHandlers() {
    const answerPath = (answerId) =>
      `/integrations/discord-bot/answers/${encodeURIComponent(answerId)}`;
    this.ipcMain.handle("discord-bot:settings", () => this.bot.directory.refresh());
    this.ipcMain.handle("discord-bot:model:update", (_event, model) =>
      this.bot.directory.updateModel(model));
    this.ipcMain.handle("discord-bot:permissions:update", (_event, permissions) =>
      this.bot.directory.updatePermissions(permissions));
    this.ipcMain.handle("discord-bot:roles", (_event, guildId) =>
      this.bot.directory.roles(guildId));
    this.ipcMain.handle("discord-bot:members", (_event, guildId, query) =>
      this.bot.directory.members(guildId, query));
    this.ipcMain.handle("discord-bot:subjects", (_event, guildId, subjects) =>
      this.bot.directory.subjectAvailability(guildId, subjects));
    this.ipcMain.handle("discord-bot:answers", (_event, query) =>
      this.getJson(`/integrations/discord-bot/answers?${historyQuery(query)}`));
    this.ipcMain.handle("discord-bot:answer", (_event, answerId) =>
      this.getJson(answerPath(answerId)));
    this.ipcMain.handle("discord-bot:answer:delete", (_event, answerId) =>
      this.deleteJson(answerPath(answerId)));
    this.ipcMain.handle("discord-bot:answers:delete", (_event, guildId) =>
      this.deleteJson(`/integrations/discord-bot/answers${guildId
        ? `?guild_id=${encodeURIComponent(guildId)}` : ""}`));
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

function historyQuery(query = {}) {
  const parameters = new URLSearchParams({
    limit: String(query.limit || 25), offset: String(query.offset || 0),
  });
  if (query.guildId) parameters.set("guild_id", query.guildId);
  if (query.channelId) parameters.set("channel_id", query.channelId);
  return parameters.toString();
}

module.exports = { IntegrationIpcController, historyQuery };
