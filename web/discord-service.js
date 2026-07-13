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
      importMessages: (sessionId, messages) => this.importBatches(sessionId, messages),
      finishSession: (sessionId, reason) => this.finishSession(sessionId, reason),
      listSyncStates: (sourceType) => this.backend.get(
        `/integrations/sync-states?source_type=${encodeURIComponent(sourceType)}`,
      ),
      saveSyncState: (state) => this.backend.post("/integrations/sync-state", state),
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

  disconnect() {
    return this.bot.disconnect();
  }

  invite() {
    return { invite_url: this.bot.inviteUrl() };
  }

  shutdown() {
    return this.bot.shutdown();
  }
}

module.exports = { DiscordService };
