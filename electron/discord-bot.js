const { Events } = require("discord.js");
const { DiscordBotBatcher } = require("./discord-bot-batcher");
const { DiscordBotChannelSynchronizer, maximumId } = require("./discord-bot-channel-sync");
const { discordChannelContext, discordMessageToInput } = require("./discord-bot-message");
const { DiscordBotCommands } = require("./discord-bot-commands");
const { DiscordBotAccessPolicy } = require("./discord-bot-access");
const { DiscordBotDirectory } = require("./discord-bot-directory");
const { DiscordBotQuestionHandler } = require("./discord-bot-questions");
const { DiscordBotStateStore } = require("./discord-bot-state-store");
const { discordBotInviteUrl, discordBotStatus } = require("./discord-bot-status");
const { createDiscordBotClient } = require("./discord-bot-client");

class DiscordBotController {
  constructor(options) {
    this.api = options.api;
    this.onProgress = options.onProgress || (() => {});
    this.tokenStore = options.tokenStore || createElectronTokenStore();
    this.client = null;
    this.hasStoredToken = false;
    this.enabled = false;
    this.stateStore = new DiscordBotStateStore(this.api);
    this.states = this.stateStore.states;
    this.lastError = null;
    this.directory = new DiscordBotDirectory({
      api: this.api, getClient: () => this.client,
    });
    this.access = new DiscordBotAccessPolicy(() => this.directory.current());
    this.batcher = new DiscordBotBatcher({
      ...this.api, onProgress: this.onProgress,
      onStored: (context, messages) => this.updateCursor(context, messages),
    });
    this.synchronizer = new DiscordBotChannelSynchronizer({
      ...this.api, saveState: (state) => this.saveState(state),
      onProgress: this.onProgress,
    });
    this.commands = new DiscordBotCommands({
      getState: (id) => this.states.get(id),
      refreshState: (id) => this.refreshState(id),
      setState: (id, state) => this.states.set(id, state),
      deleteState: (id) => this.states.delete(id),
      saveState: (state) => this.saveState(state),
      synchronizer: this.synchronizer,
      canManage: (member, guildId) => this.access.permits(member, guildId, "sync"),
    });
    this.questions = new DiscordBotQuestionHandler({
      api: this.api, getSettings: () => this.directory.current(),
      access: this.access, onProgress: this.onProgress,
    });
  }

  async restore() {
    try {
      const token = this.tokenStore.load();
      this.hasStoredToken = Boolean(token);
      this.enabled = this.hasStoredToken && storedBotEnabled(this.tokenStore);
      if (!token || !this.enabled) return this.status();
      return await this.connect(token, false);
    } catch (error) {
      this.lastError = error.message;
      return this.status();
    }
  }

  async connect(token, shouldSave = true) {
    if (!token?.trim()) throw new Error("Discord bot token je prázdný.");
    if (this.client) await this.disconnect(false);
    const client = this.createClient();
    this.client = client;
    const ready = new Promise((resolve, reject) => {
      client.once(Events.ClientReady, resolve);
      client.once(Events.Error, reject);
    });
    try {
      await client.login(token.trim());
      await ready;
      if (shouldSave) this.tokenStore.save(token);
      this.tokenStore.setEnabled?.(true);
      this.hasStoredToken = true;
      this.enabled = true;
      this.lastError = null;
      await this.loadStates();
      await this.directory.refresh();
      await this.commands.register(this.client);
      void this.catchUpTrackedChannels();
      return this.status();
    } catch (error) {
      client.destroy();
      this.client = null;
      this.lastError = error.message;
      throw new Error(`Discord bot se nepodařilo připojit: ${error.message}`);
    }
  }

  createClient() {
    return createDiscordBotClient(this);
  }

  async handleLiveMessage(message) {
    try {
      if (message.partial) message = await message.fetch();
      const state = this.states.get(message.channelId);
      if (!state?.tracking_enabled) return;
      this.batcher.add(discordMessageToInput(message), discordChannelContext(message.channel));
    } catch (error) {
      this.lastError = error.message;
      this.onProgress({ type: "error", conversationId: message.channelId, error: error.message });
    }
  }

  async handleInteraction(interaction) {
    try {
      await this.commands.handle(interaction);
    } catch (error) {
      this.lastError = error.message;
      this.onProgress({ type: "error", error: error.message });
    }
  }

  async handleQuestion(message) {
    try {
      await this.questions.handle(message, this.client?.user?.id);
    } catch (error) {
      this.lastError = error.message;
      this.onProgress({
        type: "error", conversationId: message.channelId, error: error.message,
      });
    }
  }

  async loadStates() {
    await this.stateStore.load();
  }

  async saveState(state) {
    return this.stateStore.save(state);
  }

  async refreshState(channelId) {
    return this.stateStore.refresh(channelId);
  }

  async updateCursor(context, messages) {
    const current = this.states.get(context.conversation_id);
    if (!current) return;
    const newest = messages.reduce(
      (cursor, message) => maximumId(cursor, message.external_id), current.newest_cursor,
    );
    await this.saveState({ ...current, newest_cursor: newest, last_error: null });
  }

  async catchUpTrackedChannels() {
    for (const state of this.states.values()) {
      if (!state.tracking_enabled) continue;
      try {
        const channel = await this.client.channels.fetch(state.conversation_id);
        if (!channel?.isTextBased()) continue;
        const result = await this.synchronizer.catchUp(channel, state);
        this.states.set(state.conversation_id, result.state);
      } catch (error) {
        await this.stateStore.update(state.conversation_id, (current) => ({
          ...current, last_error: error.message,
        }));
      }
    }
  }

  inviteUrl() {
    return discordBotInviteUrl(this.client);
  }

  status() {
    return discordBotStatus(this);
  }

  async pause() {
    if (!this.hasStoredToken) throw new Error("Discord bot nemá uložený token.");
    await this.disconnect(false);
    this.tokenStore.setEnabled?.(false);
    this.enabled = false;
    this.lastError = null;
    return this.status();
  }

  async resume() {
    if (this.client?.isReady()) return this.status();
    const token = this.tokenStore.load();
    if (!token) throw new Error("Discord bot nemá uložený token.");
    this.hasStoredToken = true;
    return this.connect(token, false);
  }

  async disconnect(forgetToken = true) {
    await this.batcher.flushAll();
    this.client?.destroy();
    this.client = null;
    if (forgetToken) {
      this.tokenStore.clear();
      this.hasStoredToken = false;
      this.enabled = false;
      this.lastError = null;
    }
    return this.status();
  }

  async shutdown() {
    return this.disconnect(false);
  }
}

function createElectronTokenStore() {
  const { DiscordBotTokenStore } = require("./discord-bot-token-store");
  const { ToggleableSecretStore } = require("../runtime/toggleable-secret-store");
  const secretStore = new DiscordBotTokenStore();
  return new ToggleableSecretStore(secretStore, `${secretStore.filePath}.state.json`);
}

function storedBotEnabled(tokenStore) { return tokenStore.isEnabled?.() ?? true; }

module.exports = { DiscordBotController };
