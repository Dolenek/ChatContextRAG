class DiscordBotStateStore {
  constructor(api) {
    this.api = api;
    this.states = new Map();
    this.writeQueues = new Map();
  }

  async load() {
    const persistedStates = await this.api.listSyncStates("discord");
    this.states.clear();
    persistedStates.forEach((state) => this.states.set(state.conversation_id, state));
    return this.states;
  }

  save(state) {
    const channelId = state.conversation_id;
    const previousWrite = this.writeQueues.get(channelId) || Promise.resolve();
    const nextWrite = previousWrite.catch(() => {}).then(() => this.persist(state));
    this.writeQueues.set(channelId, nextWrite);
    nextWrite.then(
      () => this.clearWrite(channelId, nextWrite),
      () => this.clearWrite(channelId, nextWrite),
    );
    return nextWrite;
  }

  async persist(state) {
    const protectedState = this.preserveStop(state);
    const saved = await this.api.saveSyncState(protectedState);
    const current = this.preserveStop(saved);
    this.states.set(current.conversation_id, current);
    return current;
  }

  preserveStop(state) {
    const current = this.states.get(state.conversation_id);
    return current?.tracking_enabled === false && state.tracking_enabled
      ? { ...state, tracking_enabled: false } : state;
  }

  clearWrite(channelId, write) {
    if (this.writeQueues.get(channelId) === write) this.writeQueues.delete(channelId);
  }

  async refresh(channelId) {
    await this.writeQueues.get(channelId)?.catch(() => {});
    const persistedStates = await this.api.listSyncStates("discord");
    persistedStates.forEach((state) => {
      const current = this.preserveStop(state);
      this.states.set(current.conversation_id, current);
    });
    return this.states.get(channelId);
  }
}

module.exports = { DiscordBotStateStore };
