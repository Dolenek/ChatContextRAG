class DiscordBotBatcher {
  constructor(options) {
    this.createSession = options.createSession;
    this.importMessages = options.importMessages;
    this.finishSession = options.finishSession;
    this.onStored = options.onStored || (() => {});
    this.onProgress = options.onProgress || (() => {});
    this.idleMs = options.idleMs || 30_000;
    this.maximumMs = options.maximumMs || 60_000;
    this.maximumMessages = options.maximumMessages || 100;
    this.buffers = new Map();
  }

  add(message, context) {
    let buffer = this.buffers.get(context.conversation_id);
    if (!buffer) buffer = this.createBuffer(context);
    buffer.messages.set(message.external_id, message);
    clearTimeout(buffer.idleTimer);
    buffer.idleTimer = setTimeout(() => this.flush(context.conversation_id), this.idleMs);
    if (buffer.messages.size >= this.maximumMessages) {
      void this.flush(context.conversation_id);
    }
  }

  createBuffer(context) {
    const buffer = { context, messages: new Map(), idleTimer: null, maximumTimer: null };
    buffer.maximumTimer = setTimeout(
      () => this.flush(context.conversation_id), this.maximumMs,
    );
    this.buffers.set(context.conversation_id, buffer);
    return buffer;
  }

  async flush(conversationId) {
    const buffer = this.buffers.get(conversationId);
    if (!buffer || !buffer.messages.size) return null;
    this.buffers.delete(conversationId);
    clearTimeout(buffer.idleTimer);
    clearTimeout(buffer.maximumTimer);
    const messages = [...buffer.messages.values()];
    let session = null;
    try {
      session = await this.createSession(buffer.context);
      await this.importMessages(session.session_id, messages);
      const finished = await this.finishSession(session.session_id, "completed");
      await this.onStored(buffer.context, messages, finished);
      this.onProgress({ type: "live", conversationId, imported: messages.length });
      return finished;
    } catch (error) {
      if (session) await this.finishSession(session.session_id, "stopped").catch(() => {});
      this.onProgress({ type: "error", conversationId, error: error.message });
      throw error;
    }
  }

  async flushAll() {
    const conversationIds = [...this.buffers.keys()];
    return Promise.allSettled(conversationIds.map((id) => this.flush(id)));
  }
}

module.exports = { DiscordBotBatcher };
