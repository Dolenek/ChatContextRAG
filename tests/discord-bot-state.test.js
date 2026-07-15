const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { Events } = require("discord.js");

const { DiscordBotCommands } = require("../electron/discord-bot-commands");
const { DiscordBotController } = require("../electron/discord-bot");

test("Discord stop persists across a fresh status read", async () => {
  let durableState = {
    source_type: "discord", conversation_id: "20", tracking_enabled: true,
    backfill_complete: true, raw_message_count: 12, indexed_message_count: 10,
  };
  const commands = new DiscordBotCommands({
    getState: () => durableState,
    refreshState: async () => durableState,
    setState: (_channelId, state) => { durableState = state; },
    saveState: async (state) => { durableState = state; return state; },
    synchronizer: { mergeState: (_context, state, overrides) => ({ ...state, ...overrides }) },
    canManage: () => true,
  });

  const stop = fakeInteraction("stop");
  await commands.handle(stop);
  const status = fakeInteraction("status");
  await commands.handle(status);

  assert.equal(durableState.tracking_enabled, false);
  assert.match(stop.replies[0].content, /vypnuto/);
  assert.match(status.replies[0].content, /Sledování: vypnuté/);
});

test("Discord state writes cannot re-enable a channel after stop", async () => {
  const gate = deferred();
  const started = deferred();
  const persisted = [];
  const controller = createController({
    listSyncStates: async () => persisted.slice(-1),
    saveSyncState: async (state) => {
      if (!persisted.length) {
        started.resolve();
        await gate.promise;
      }
      persisted.push({ ...state });
      return { ...state };
    },
  });
  const active = { conversation_id: "20", source_type: "discord", tracking_enabled: true };
  controller.states.set("20", active);
  const staleWrite = controller.saveState({ ...active, newest_cursor: "101" });
  await started.promise;
  controller.states.set("20", { ...active, tracking_enabled: false });
  const stopWrite = controller.saveState({ ...active, tracking_enabled: false });

  gate.resolve();
  await Promise.all([staleWrite, stopWrite]);

  assert.deepEqual(persisted.map((state) => state.tracking_enabled), [true, false]);
  assert.equal((await controller.refreshState("20")).tracking_enabled, false);
});

test("background catch-up error preserves the synchronizer's cleared session", async () => {
  const persisted = [];
  const controller = createController({
    saveSyncState: async (state) => {
      persisted.push({ ...state });
      return { ...state };
    },
  });
  const staleState = {
    conversation_id: "20", source_type: "discord", tracking_enabled: true,
    active_session_id: "stopped-session", backfill_complete: false,
  };
  controller.states.set("20", staleState);
  controller.client = { channels: { fetch: async () => ({ isTextBased: () => true }) } };
  controller.synchronizer.catchUp = async () => {
    await controller.saveState({
      ...staleState, active_session_id: null, last_error: "session stopped",
    });
    throw new Error("session stopped");
  };

  await controller.catchUpTrackedChannels();

  assert.equal(persisted.at(-1).active_session_id, null);
  assert.equal(controller.states.get("20").active_session_id, null);
});

test("Discord status refresh loads durable archive counts", async () => {
  const persisted = {
    conversation_id: "20", source_type: "discord", tracking_enabled: true,
    raw_message_count: 48, indexed_message_count: 42,
  };
  const controller = createController({
    listSyncStates: async () => [persisted], saveSyncState: async (state) => state,
  });
  controller.states.set("20", { ...persisted, raw_message_count: 0, indexed_message_count: 0 });

  const refreshed = await controller.refreshState("20");

  assert.equal(refreshed.raw_message_count, 48);
  assert.equal(refreshed.indexed_message_count, 42);
});

test("an explicit Discord sync re-enables a stopped channel", async () => {
  let state = {
    conversation_id: "20", source_type: "discord", tracking_enabled: false,
    backfill_complete: true,
  };
  const commands = new DiscordBotCommands({
    getState: () => state, refreshState: async () => state,
    setState: (_channelId, nextState) => { state = nextState; },
    saveState: async (nextState) => nextState, canManage: () => true,
    synchronizer: {
      mergeState: (_context, current, overrides) => ({ ...current, ...overrides }),
      catchUp: async (_channel, enabledState) => ({ state: enabledState, imported: 0 }),
    },
  });

  await commands.handle(fakeInteraction("sync"));

  assert.equal(state.tracking_enabled, true);
});

test("a disabled Discord bot stays offline while retaining its token", async () => {
  let connectionAttempts = 0;
  const controller = createController({}, {
    load: () => "stored-token", isEnabled: () => false, clear: () => {},
  });
  controller.connect = async () => { connectionAttempts += 1; };

  const status = await controller.restore();

  assert.equal(connectionAttempts, 0);
  assert.equal(status.connected, false);
  assert.equal(status.hasToken, true);
  assert.equal(status.enabled, false);
});

test("Discord bot pause and resume reuse the encrypted token", async () => {
  const enabledWrites = [];
  const tokenStore = {
    load: () => "stored-token", clear: () => {},
    setEnabled: (enabled) => enabledWrites.push(enabled),
  };
  const controller = createController({}, tokenStore);
  controller.hasStoredToken = true;
  controller.enabled = true;
  controller.client = { isReady: () => true, destroy: () => {} };
  controller.batcher.flushAll = async () => [];

  const paused = await controller.pause();
  controller.createClient = () => readyDiscordClient();
  controller.loadStates = async () => {};
  controller.directory.refresh = async () => {};
  controller.commands.register = async () => {};
  const resumed = await controller.resume();

  assert.equal(paused.hasToken, true);
  assert.equal(paused.enabled, false);
  assert.equal(resumed.connected, true);
  assert.deepEqual(enabledWrites, [false, true]);
});

function createController(api, tokenStore = { load: () => null, clear: () => {} }) {
  return new DiscordBotController({
    api: {
      ...api, createSession: async () => ({}), importMessages: async () => {},
      finishSession: async () => ({}),
    },
    tokenStore,
  });
}

function fakeInteraction(subcommand) {
  const replies = [];
  return {
    replies, commandName: "chatcontext", channelId: "20", guildId: "10",
    channel: { id: "20", name: "general", guildId: "10", guild: { name: "Workspace" } },
    member: {}, isChatInputCommand: () => true, inGuild: () => true,
    options: { getSubcommand: () => subcommand }, deferReply: async () => {},
    editReply: async (value) => replies.push(
      typeof value === "string" ? { content: value } : value,
    ),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function readyDiscordClient() {
  const client = new EventEmitter();
  client.login = async () => queueMicrotask(() => client.emit(Events.ClientReady, client));
  client.isReady = () => true;
  client.destroy = () => {};
  client.user = { tag: "Bot#0001" };
  return client;
}
