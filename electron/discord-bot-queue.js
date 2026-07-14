class DiscordBotQuestionQueue {
  constructor(options = {}) {
    this.maximumPending = options.maximumPending ?? 5;
    this.cooldownMs = options.cooldownMs ?? 10_000;
    this.now = options.now || Date.now;
    this.channels = new Map();
    this.lastAccepted = new Map();
  }

  submit(channelId, userKey, operation) {
    const lastAccepted = this.lastAccepted.get(userKey);
    if (lastAccepted !== undefined && this.now() - lastAccepted < this.cooldownMs) {
      return "cooldown";
    }
    const state = this.channels.get(channelId) || { running: false, pending: [] };
    if (state.running && state.pending.length >= this.maximumPending) return "full";
    this.lastAccepted.set(userKey, this.now());
    this.channels.set(channelId, state);
    if (state.running) {
      state.pending.push(operation);
      return "queued";
    }
    state.running = true;
    void this.run(channelId, operation);
    return "active";
  }

  async run(channelId, operation) {
    try {
      await operation();
    } catch (_error) {
      // The operation owns user-facing error handling.
    }
    const state = this.channels.get(channelId);
    const next = state?.pending.shift();
    if (next) return this.run(channelId, next);
    this.channels.delete(channelId);
  }
}

module.exports = { DiscordBotQuestionQueue };
