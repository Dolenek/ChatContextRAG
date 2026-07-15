const { discordChannelContext, discordMessageToInput } = require("./discord-bot-message");

class DiscordBotChannelSynchronizer {
  constructor(options) {
    this.createSession = options.createSession;
    this.getSession = options.getSession;
    this.importMessages = options.importMessages;
    this.finishSession = options.finishSession;
    this.saveState = options.saveState;
    this.onProgress = options.onProgress || (() => {});
  }

  async syncHistory(channel, existingState = {}) {
    const context = discordChannelContext(channel);
    let state = this.mergeState(context, existingState, { tracking_enabled: true });
    let session;
    ({ session, state } = await this.openSession(context, state));
    try {
      let before = state.backfill_complete ? null : state.oldest_cursor;
      let imported = 0;
      do {
        const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
        if (!page.size) {
          state = await this.saveState({ ...state, backfill_complete: true, last_error: null });
          break;
        }
        assertReadableContent(page);
        const messages = chronological(page).map(discordMessageToInput);
        await this.importMessages(session.session_id, messages);
        imported += messages.length;
        before = messages[0].external_id;
        state = await this.saveState({
          ...state, oldest_cursor: minimumId(state.oldest_cursor, before),
          newest_cursor: maximumId(state.newest_cursor, messages.at(-1).external_id),
          backfill_complete: page.size < 100, last_error: null,
        });
        this.onProgress({ type: "backfill", conversationId: channel.id, imported });
        if (page.size < 100) break;
      } while (true);
      const finished = await this.finishSession(session.session_id, "completed");
      state = await this.saveState({ ...state, active_session_id: null, last_error: null });
      return { state, imported, indexingJobId: finished.indexing_job_id };
    } catch (error) {
      await this.finishSession(session.session_id, "stopped").catch(() => {});
      await this.saveState({ ...state, active_session_id: null, last_error: error.message });
      throw error;
    }
  }

  async catchUp(channel, existingState) {
    if (!existingState.backfill_complete) return this.syncHistory(channel, existingState);
    const context = discordChannelContext(channel);
    let state = this.mergeState(context, existingState, {});
    let session;
    ({ session, state } = await this.openSession(context, state));
    let imported = 0;
    try {
      let after = state.newest_cursor;
      do {
        const page = await channel.messages.fetch({ limit: 100, ...(after ? { after } : {}) });
        if (!page.size) break;
        const messages = chronological(page).map(discordMessageToInput);
        await this.importMessages(session.session_id, messages);
        imported += messages.length;
        after = messages.at(-1).external_id;
        state = await this.saveState({
          ...state, newest_cursor: maximumId(state.newest_cursor, after), last_error: null,
        });
        if (page.size < 100) break;
      } while (true);
      const finished = await this.finishSession(session.session_id, "completed");
      state = await this.saveState({ ...state, active_session_id: null, last_error: null });
      if (imported) this.onProgress({ type: "catchup", conversationId: channel.id, imported });
      return { state, imported, indexingJobId: finished.indexing_job_id };
    } catch (error) {
      await this.finishSession(session.session_id, "stopped").catch(() => {});
      await this.saveState({ ...state, active_session_id: null, last_error: error.message });
      throw error;
    }
  }

  mergeState(context, state, overrides) {
    return {
      source_type: "discord", conversation_id: context.conversation_id,
      container_id: context.container_id, conversation_label: context.conversation_label,
      container_label: context.container_label, oldest_cursor: null, newest_cursor: null,
      active_session_id: null, backfill_complete: false,
      tracking_enabled: true, last_error: null,
      ...state, ...overrides,
    };
  }

  async openSession(context, state) {
    if (state.active_session_id) {
      const activeSession = await this.loadSession(state.active_session_id);
      if (activeSession.status === "running") {
        return { session: { session_id: state.active_session_id }, state };
      }
      state = await this.saveState({
        ...state, active_session_id: null,
        last_error: `Předchozí ingestion session byla ${activeSession.status}.`,
      });
    }
    const session = await this.createSession(context);
    const savedState = await this.saveState({
      ...state, active_session_id: session.session_id, last_error: null,
    });
    return { session, state: savedState };
  }

  async loadSession(sessionId) {
    try { return await this.getSession(sessionId); }
    catch (error) {
      if (error.statusCode === 404) return { status: "missing" };
      throw error;
    }
  }
}

function chronological(collection) {
  return [...collection.values()].sort((left, right) => compareIds(left.id, right.id));
}

function compareIds(left, right) {
  const leftId = BigInt(left);
  const rightId = BigInt(right);
  return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
}

function minimumId(left, right) {
  if (!left) return right;
  return compareIds(left, right) <= 0 ? left : right;
}

function maximumId(left, right) {
  if (!left) return right;
  return compareIds(left, right) >= 0 ? left : right;
}

function assertReadableContent(collection) {
  if (collection.size < 5) return;
  const hasReadableMessage = [...collection.values()].some((message) =>
    message.content || message.attachments?.size || message.embeds?.length);
  if (!hasReadableMessage) {
    throw new Error(
      "Discord nevrátil obsah zpráv. Zapněte botovi Message Content intent.",
    );
  }
}

module.exports = { DiscordBotChannelSynchronizer, maximumId };
