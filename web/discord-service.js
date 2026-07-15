const { DiscordBotController } = require("../electron/discord-bot");

class DiscordService {
  constructor(options) {
    this.backend = options.backend;
    this.events = options.events;
    this.monitor = options.monitor;
    this.bot = new DiscordBotController({
      api: this.botApi(),
      tokenStore: options.tokenStore,
      onProgress: (progress) => this.events.publish("discord-bot", progress),
    });
  }

  botApi() {
    return {
      createSession: (context) => this.backend.post("/ingestion/sessions", context),
      getSession: (sessionId) => this.backend.get(
        `/ingestion/sessions/${encodeURIComponent(sessionId)}`,
      ),
      importMessages: (sessionId, messages) => this.importBatches(sessionId, messages),
      finishSession: (sessionId, reason) => this.finishSession(sessionId, reason),
      listSyncStates: (sourceType) => this.backend.get(
        `/integrations/sync-states?source_type=${encodeURIComponent(sourceType)}`,
      ),
      saveSyncState: (state) => this.backend.post("/integrations/sync-state", state),
      getDiscordBotSettings: () => this.backend.get("/integrations/discord-bot/settings"),
      updateDiscordBotModel: (model) =>
        this.backend.put("/integrations/discord-bot/settings/model", model),
      updateDiscordGuildPermissions: (permissions) => this.backend.put(
        `/integrations/discord-bot/guilds/${encodeURIComponent(permissions.guild_id)}/permissions`,
        permissions,
      ),
      answerDiscordQuestion: (request) => this.backend.post(
        "/integrations/discord-bot/answers", request, { timeoutMs: 130_000 },
      ),
      recordDiscordAnswerDelivery: (answerId, update) => this.backend.patch(
        `/integrations/discord-bot/answers/${encodeURIComponent(answerId)}/delivery`, update,
      ),
    };
  }

  async importBatches(sessionId, messages) {
    let latest = null;
    for (let start = 0; start < messages.length; start += 400) {
      latest = await this.backend.post("/messages/import", {
        session_id: sessionId,
        messages: messages.slice(start, start + 400),
      });
    }
    return latest;
  }

  async finishSession(sessionId, reason) {
    const session = await this.backend.post(
      `/ingestion/sessions/${sessionId}/finish`, { reason },
    );
    this.monitor?.startSessionJobs(session);
    return session;
  }

  restore() {
    return this.bot.restore();
  }

  status() {
    return this.bot.status();
  }

  connect(token) {
    return this.bot.connect(token);
  }

  pause() {
    return this.bot.pause();
  }

  resume() {
    return this.bot.resume();
  }

  disconnect() {
    return this.bot.disconnect();
  }

  invite() {
    return { invite_url: this.bot.inviteUrl() };
  }

  settings() { return this.bot.directory.refresh(); }
  updateModel(model) { return this.bot.directory.updateModel(model); }
  updatePermissions(permissions) { return this.bot.directory.updatePermissions(permissions); }
  roles(guildId) { return this.bot.directory.roles(guildId); }
  members(guildId, query) { return this.bot.directory.members(guildId, query); }
  subjectAvailability(guildId, subjects) {
    return this.bot.directory.subjectAvailability(guildId, subjects);
  }

  listAnswers(query) {
    return this.backend.get(`/integrations/discord-bot/answers?${historyQuery(query)}`);
  }

  answerDetail(answerId) {
    return this.backend.get(`/integrations/discord-bot/answers/${encodeURIComponent(answerId)}`);
  }

  deleteAnswer(answerId) {
    return this.backend.delete(
      `/integrations/discord-bot/answers/${encodeURIComponent(answerId)}`,
    );
  }

  deleteAnswers(guildId) {
    const suffix = guildId ? `?guild_id=${encodeURIComponent(guildId)}` : "";
    return this.backend.delete(`/integrations/discord-bot/answers${suffix}`);
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

module.exports = { DiscordService, historyQuery };
