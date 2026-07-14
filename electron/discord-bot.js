const {
  Client, Events, GatewayIntentBits, Partials, PermissionFlagsBits,
} = require("discord.js");
const { DiscordBotBatcher } = require("./discord-bot-batcher");
const { DiscordBotChannelSynchronizer, maximumId } = require("./discord-bot-channel-sync");
const { discordChannelContext, discordMessageToInput } = require("./discord-bot-message");
const { DiscordBotCommands } = require("./discord-bot-commands");
const { DiscordBotAccessPolicy } = require("./discord-bot-access");
const { DiscordBotDirectory } = require("./discord-bot-directory");
const { DiscordBotQuestionHandler } = require("./discord-bot-questions");

class DiscordBotController {
  constructor(options) {
    this.api = options.api;
    this.onProgress = options.onProgress || (() => {});
    this.tokenStore = options.tokenStore || createElectronTokenStore();
    this.client = null;
    this.states = new Map();
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
      setState: (id, state) => this.states.set(id, state),
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
    const token = this.tokenStore.load();
    if (!token) return this.status();
    try {
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
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Message, Partials.Channel],
    });
    client.on(Events.InteractionCreate, (interaction) => this.commands.handle(interaction));
    client.on(Events.MessageCreate, (message) => this.handleLiveMessage(message));
    client.on(Events.MessageCreate, (message) => this.handleQuestion(message));
    client.on(Events.MessageUpdate, (_oldMessage, message) => this.handleLiveMessage(message));
    client.on(Events.Error, (error) => {
      this.lastError = error.message;
      this.onProgress({ type: "error", error: error.message });
    });
    return client;
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
    const states = await this.api.listSyncStates("discord");
    this.states = new Map(states.map((state) => [state.conversation_id, state]));
  }

  async saveState(state) {
    const saved = await this.api.saveSyncState(state);
    this.states.set(saved.conversation_id, saved);
    return saved;
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
        await this.saveState({ ...state, last_error: error.message });
      }
    }
  }

  inviteUrl() {
    if (!this.client?.isReady()) throw new Error("Nejdřív připojte Discord bota.");
    return this.client.generateInvite({
      scopes: ["bot", "applications.commands"],
      permissions: [
        PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.AddReactions,
      ],
    });
  }

  status() {
    const states = [...this.states.values()];
    return {
      connected: Boolean(this.client?.isReady()),
      botName: this.client?.user?.tag || null,
      trackedChannels: states.filter((state) => state.tracking_enabled).length,
      rawMessages: states.reduce((sum, state) => sum + (state.raw_message_count || 0), 0),
      indexedMessages: states.reduce(
        (sum, state) => sum + (state.indexed_message_count || 0), 0,
      ),
      lastError: this.lastError,
    };
  }

  async disconnect(forgetToken = true) {
    await this.batcher.flushAll();
    this.client?.destroy();
    this.client = null;
    if (forgetToken) this.tokenStore.clear();
    return this.status();
  }

  async shutdown() {
    return this.disconnect(false);
  }
}

function createElectronTokenStore() {
  const { DiscordBotTokenStore } = require("./discord-bot-token-store");
  return new DiscordBotTokenStore();
}

module.exports = { DiscordBotController };
