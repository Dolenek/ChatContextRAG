const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { ConnectionIpcController } = require("../electron/connection-ipc");
const { DiscordBotBatcher } = require("../electron/discord-bot-batcher");
const { DiscordBotChannelSynchronizer, maximumId } = require("../electron/discord-bot-channel-sync");
const { DiscordBotCommands } = require("../electron/discord-bot-commands");
const { DiscordBotController } = require("../electron/discord-bot");
const { discordChannelContext, discordMessageToInput } = require("../electron/discord-bot-message");
const { takeChronologicalBatch } = require("../electron/discord-message-batch");
const {
  createScanSummary, findUnseenMessages, getChannelRoute, isCurrentChannel,
  updateTopConfirmation,
} = require("../electron/discord-scan-state");
const { DiscordViewController } = require("../electron/discord-view");
const { IntegrationIpcController } = require("../electron/integration-ipc");
const { RemoteIntegrationIpcController } = require("../electron/remote-integration-ipc");
const { RemoteSettingsIpcController } = require("../electron/remote-settings-ipc");
const { SettingsIpcController } = require("../electron/settings-ipc");

test("Discord messages preserve source identity, attachments, edits, and display names", () => {
  const channel = { id: "20", name: "general", guildId: "10", guild: { name: "Workspace" } };
  const input = discordMessageToInput({
    id: "123", content: "  release plan  ",
    attachments: new Map([["a", { name: "plan.pdf" }]]),
    member: { displayName: "Ada" }, author: { username: "fallback" },
    createdAt: new Date("2026-07-13T10:00:00Z"),
    editedAt: new Date("2026-07-13T10:05:00Z"),
    channel, channelId: "20", guildId: "10", guild: channel.guild,
  });

  assert.equal(input.author, "Ada");
  assert.match(input.content, /release plan\n.*plan\.pdf/);
  assert.equal(input.conversation_id, "20");
  assert.equal(input.container_label, "Workspace");
  assert.equal(input.source_metadata.attachment_count, 1);
  assert.equal(input.source_metadata.edited_timestamp, "2026-07-13T10:05:00.000Z");
  assert.deepEqual(discordChannelContext(channel), {
    guild_id: "10", channel_id: "20", channel: "general", source_type: "discord",
    conversation_id: "20", conversation_label: "general", container_id: "10",
    container_label: "Workspace",
  });
});

test("Discord batch ordering handles snowflakes without numeric precision loss", () => {
  const pending = new Map([
    ["large", { external_id: "10000000000000000002" }],
    ["small", { external_id: "9" }],
    ["middle", { external_id: "10000000000000000001" }],
  ]);

  const batch = takeChronologicalBatch(pending, 2);

  assert.deepEqual(batch.map((item) => item.external_id), [
    "9", "10000000000000000001",
  ]);
  assert.equal(maximumId("10000000000000000001", "10000000000000000002"),
    "10000000000000000002");
});

test("live batch failures stop the session and report the error", async () => {
  const finished = [];
  const progress = [];
  const batcher = new DiscordBotBatcher({
    idleMs: 10_000, maximumMs: 20_000,
    createSession: async () => ({ session_id: "session-1" }),
    importMessages: async () => { throw new Error("storage offline"); },
    finishSession: async (sessionId, reason) => finished.push([sessionId, reason]),
    onProgress: (item) => progress.push(item),
  });
  batcher.add({ external_id: "1" }, { conversation_id: "20" });

  await assert.rejects(batcher.flush("20"), /storage offline/);

  assert.deepEqual(finished, [["session-1", "stopped"]]);
  assert.equal(progress[0].type, "error");
  assert.equal(batcher.buffers.size, 0);
});

test("catch-up imports messages after the newest durable cursor", async () => {
  const imports = [];
  const fetches = [];
  const channel = fakeChannel([fakeDiscordMessage("301"), fakeDiscordMessage("302")], fetches);
  const synchronizer = new DiscordBotChannelSynchronizer({
    createSession: async () => ({ session_id: "session-1" }),
    importMessages: async (...arguments) => imports.push(arguments),
    finishSession: async () => ({ indexing_job_id: "job-1" }),
    saveState: async (state) => state,
  });

  const result = await synchronizer.catchUp(channel, {
    source_type: "discord", conversation_id: "20", newest_cursor: "300",
    backfill_complete: true, tracking_enabled: true,
  });

  assert.deepEqual(fetches[0], { limit: 100, after: "300" });
  assert.equal(imports[0][0], "session-1");
  assert.deepEqual(imports[0][1].map((item) => item.external_id), ["301", "302"]);
  assert.equal(result.state.newest_cursor, "302");
  assert.equal(result.state.active_session_id, null);
});

test("history sync rejects pages hidden by a missing Message Content intent", async () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    ...fakeDiscordMessage(String(index + 1)), content: "", embeds: [], attachments: new Map(),
  }));
  const finished = [];
  const saved = [];
  const synchronizer = new DiscordBotChannelSynchronizer({
    createSession: async () => ({ session_id: "session-1" }),
    importMessages: async () => {},
    finishSession: async (_sessionId, reason) => finished.push(reason),
    saveState: async (state) => { saved.push(state); return state; },
  });

  await assert.rejects(synchronizer.syncHistory(fakeChannel(messages), {}), /Message Content/);

  assert.deepEqual(finished, ["stopped"]);
  assert.match(saved.at(-1).last_error, /Message Content/);
});

test("Discord slash commands enforce permission and report channel status", async () => {
  const commands = new DiscordBotCommands({
    getState: () => ({
      tracking_enabled: true, backfill_complete: true,
      raw_message_count: 12, indexed_message_count: 10,
    }),
    setState: () => {}, saveState: async () => {}, synchronizer: {},
    canManage: (member) => member.permitted,
  });
  const denied = fakeInteraction({ permitted: false });
  await commands.handle(denied);
  assert.equal(denied.deferCalls.length, 1);
  assert.match(denied.replies[0].content, /nastavení Discord bota/);

  const status = fakeInteraction({ subcommand: "status" });
  await commands.handle(status);
  assert.match(status.replies[0].content, /raw 12/);
  assert.match(status.replies[0].content, /index 10/);

  const unrelated = fakeInteraction({ commandName: "other" });
  assert.equal(await commands.handle(unrelated), undefined);
  assert.deepEqual(unrelated.replies, []);
  assert.deepEqual(unrelated.deferCalls, []);
});

test("Discord bot controller tracks live messages, cursors, status, and disconnect", async () => {
  const saved = [];
  let cleared = 0;
  let destroyed = 0;
  const controller = new DiscordBotController({
    api: {
      listSyncStates: async () => [], saveSyncState: async (state) => { saved.push(state); return state; },
      createSession: async () => ({}), importMessages: async () => {}, finishSession: async () => ({}),
    },
    tokenStore: { load: () => null, clear: () => { cleared += 1; } },
  });
  controller.states.set("20", {
    conversation_id: "20", tracking_enabled: true, newest_cursor: "100",
    raw_message_count: 4, indexed_message_count: 3,
  });
  const batched = [];
  controller.batcher.add = (...arguments) => batched.push(arguments);
  await controller.handleLiveMessage({ ...fakeDiscordMessage("101"), channelId: "20" });
  await controller.updateCursor({ conversation_id: "20" }, [
    { external_id: "102" }, { external_id: "105" },
  ]);
  controller.client = {
    isReady: () => true, user: { tag: "Bot#0001" }, destroy: () => { destroyed += 1; },
  };
  controller.batcher.flushAll = async () => [];

  assert.equal(batched.length, 1);
  assert.equal(saved.at(-1).newest_cursor, "105");
  assert.deepEqual(controller.status(), {
    connected: true, hasToken: false, enabled: false,
    botName: "Bot#0001", trackedChannels: 1,
    rawMessages: 4, indexedMessages: 3, lastError: null,
  });
  await controller.disconnect();
  assert.equal(destroyed, 1);
  assert.equal(cleared, 1);
});

test("scan state validates routes, unseen messages, and stable top confirmation", () => {
  const summary = createScanSummary();
  assert.equal(summary.state, "running");
  const route = getChannelRoute("https://discord.com/channels/10/20/30");
  assert.equal(route, "https://discord.com/channels/10/20");
  assert.equal(isCurrentChannel({ getURL: () => `${route}/40` }, route), true);
  assert.equal(isCurrentChannel({ getURL: () => "https://example.com" }, route), false);
  assert.throws(() => getChannelRoute("https://discord.com/app"), /kanál/);

  const unseen = findUnseenMessages({ messages: [
    { external_id: "1" }, { external_id: "2" }, { external_id: "3" },
  ] }, new Set(["1"]), new Map([["2", {}]]));
  assert.deepEqual(unseen, [{ external_id: "3" }]);

  const scanState = { topCandidateId: null, topConfirmationCount: 0 };
  updateTopConfirmation({ atTop: true, topMessageId: "1" }, 1, scanState);
  updateTopConfirmation({ atTop: true, topMessageId: "1" }, 0, scanState);
  assert.equal(scanState.topConfirmationCount, 2);
  updateTopConfirmation({ atTop: false }, 0, scanState);
  assert.equal(scanState.topConfirmationCount, 0);
});

test("Discord view validates deep links and delegates capture, scan, and hide", async () => {
  const mainWindow = fakeMainWindow();
  const controller = new DiscordViewController(mainWindow);
  const loaded = [];
  controller.discordView = {
    webContents: {
      getURL: () => "https://discord.com/app",
      loadURL: async (url) => loaded.push(url),
      executeJavaScript: async () => [{ external_id: "1" }],
    },
    setBounds: (bounds) => { controller.bounds = bounds; }, setAutoResize: () => {},
  };
  let stopped = 0;
  controller.channelScanner = { stop: () => { stopped += 1; }, start: () => "started" };

  assert.deepEqual(await controller.captureVisibleMessages(), [{ external_id: "1" }]);
  assert.equal(controller.startChannelScan(() => {}, () => {}), "started");
  await controller.openMessage("10", "20", "30");
  assert.equal(loaded.at(-1), "https://discord.com/channels/10/20/30");
  await assert.rejects(controller.openMessage("bad", "20", "30"), /serveru/);
  controller.hide();
  assert.equal(stopped, 1);
  assert.equal(mainWindow.views.at(-1), null);
});

test("integration IPC import helper chunks messages at the backend limit", async () => {
  const calls = [];
  const controller = Object.create(IntegrationIpcController.prototype);
  controller.postJson = async (...arguments) => { calls.push(arguments); return { ok: true }; };
  const messages = Array.from({ length: 801 }, (_, index) => ({ external_id: String(index) }));

  await controller.importMessageBatches("session-1", messages);

  assert.deepEqual(calls.map((call) => call[1].messages.length), [400, 400, 1]);
});

test("connection IPC tests local and authenticated remote targets", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const requests = [];
  global.fetch = async (...arguments) => {
    requests.push(arguments);
    return { ok: true, status: 200, text: async () => '{"mode":"web"}' };
  };
  const controller = new ConnectionIpcController({
    store: { getActive: () => ({ mode: "remote", token: "saved-token" }) }, restart: () => {},
  });

  assert.deepEqual(await controller.test({ mode: "local" }), { mode: "local", reachable: true });
  const remote = await controller.test({ mode: "remote", baseUrl: "https://server.example" });

  assert.equal(remote.capabilities.mode, "web");
  assert.equal(requests[0][0], "https://server.example/api/runtime");
  assert.equal(requests[0][1].headers.Authorization, "Bearer saved-token");
});

test("remote integration and settings helpers forward multipart files and job ids", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-remote-import-"));
  const filePath = path.join(directory, "chat.txt");
  fs.writeFileSync(filePath, "13/7/2026 09:15 - Ada: Hello");
  const multipartCalls = [];
  const remote = new RemoteIntegrationIpcController({
    client: { multipart: async (...arguments) => { multipartCalls.push(arguments); return {}; } },
    getMainWindow: () => null,
  });
  remote.selectedWhatsAppPath = filePath;
  await remote.sendWhatsAppFile("/imports/whatsapp", { conversation_id: "family", empty: "" });
  assert.equal(multipartCalls[0][0], "/imports/whatsapp");
  assert.equal(multipartCalls[0][1].get("conversation_id"), "family");
  assert.equal(multipartCalls[0][1].has("empty"), false);

  const monitored = [];
  const settings = new RemoteSettingsIpcController({}, (jobId) => monitored.push(jobId));
  const response = await settings.monitorResponse(Promise.resolve({ job_id: "job-1" }), "job_id");
  assert.equal(response.job_id, "job-1");
  assert.deepEqual(monitored, ["job-1"]);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("local settings IPC parses plain backend errors", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => ({ ok: false, status: 503, text: async () => "provider offline" });
  const controller = new SettingsIpcController({}, "token", () => {});

  await assert.rejects(controller.request("GET", "/settings/providers"), /provider offline/);
});

function fakeDiscordMessage(id) {
  const channel = { id: "20", name: "general", guildId: "10", guild: { name: "Workspace" } };
  return {
    id, content: `message ${id}`, attachments: new Map(), embeds: [],
    author: { username: "Ada" }, createdAt: new Date("2026-07-13T10:00:00Z"),
    channel, channelId: "20", guildId: "10", guild: channel.guild,
  };
}

function fakeChannel(messages, fetches = []) {
  const channel = {
    id: "20", name: "general", guildId: "10", guild: { name: "Workspace" },
  };
  channel.messages = {
    fetch: async (options) => {
      fetches.push(options);
      return new Map(messages.map((message) => [message.id, { ...message, channel }]));
    },
  };
  return channel;
}

function fakeInteraction(options = {}) {
  const replies = [];
  const deferCalls = [];
  return {
    replies, deferCalls,
    commandName: options.commandName || "chatcontext", channelId: "20", channel: fakeChannel([]),
    guildId: "10", member: { permitted: options.permitted !== false },
    isChatInputCommand: () => true, inGuild: () => true,
    memberPermissions: { has: () => options.permitted !== false },
    options: { getSubcommand: () => options.subcommand || "status" },
    deferReply: async (value) => deferCalls.push(value),
    editReply: async (value) => replies.push(
      typeof value === "string" ? { content: value } : value,
    ),
  };
}

function fakeMainWindow() {
  return {
    views: [], setBrowserView(view) { this.views.push(view); },
    getContentSize: () => [1200, 800],
  };
}
