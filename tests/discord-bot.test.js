const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DiscordBotBatcher } = require("../electron/discord-bot-batcher");
const { DiscordBotChannelSynchronizer } = require("../electron/discord-bot-channel-sync");

test("live bot batches edits by message id and closes an indexing session", async () => {
  const calls = [];
  const batcher = new DiscordBotBatcher({
    idleMs: 5, maximumMs: 50, maximumMessages: 100,
    createSession: async (context) => { calls.push(["session", context]); return { session_id: "s1" }; },
    importMessages: async (sessionId, messages) => calls.push(["import", sessionId, messages]),
    finishSession: async (sessionId, reason) => { calls.push(["finish", sessionId, reason]); return {}; },
  });
  const context = { conversation_id: "20" };
  batcher.add({ external_id: "1", content: "old" }, context);
  batcher.add({ external_id: "1", content: "edited" }, context);

  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(calls[1][2].length, 1);
  assert.equal(calls[1][2][0].content, "edited");
  assert.deepEqual(calls[2], ["finish", "s1", "completed"]);
});

test("new integration cards and isolated IPC are wired without changing old Discord id", () => {
  const root = path.resolve(__dirname, "..");
  const html = fs.readFileSync(path.join(root, "renderer", "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(root, "electron", "preload.js"), "utf8");
  const tokenStore = fs.readFileSync(
    path.join(root, "electron", "discord-bot-token-store.js"), "utf8",
  );

  assert.match(html, /id="open-discord-button"/);
  assert.match(html, /id="open-discord-bot-button"/);
  assert.match(html, /id="open-whatsapp-button"/);
  assert.match(preload, /connectDiscordBot/);
  assert.match(preload, /pauseDiscordBot/);
  assert.match(preload, /resumeDiscordBot/);
  assert.match(preload, /previewWhatsAppExport/);
  assert.match(tokenStore, /safeStorage\.encryptString/);
  assert.doesNotMatch(tokenStore, /\.env/);
});

test("interrupted backfill resumes the same durable session from its oldest cursor", async () => {
  const imports = [];
  const savedStates = [];
  const finished = [];
  const checkedSessions = [];
  const message = {
    id: "100", content: "older", attachments: new Map(), embeds: [],
    author: { username: "Ada" }, createdAt: new Date("2026-07-01T10:00:00Z"),
    channelId: "20", guildId: "10",
  };
  const channel = {
    id: "20", name: "general", guildId: "10", guild: { name: "Server" },
    messages: {
      fetch: async (options) => {
        assert.equal(options.before, "200");
        return new Map([[message.id, { ...message, channel }]]);
      },
    },
  };
  const synchronizer = new DiscordBotChannelSynchronizer({
    getSession: async (sessionId) => {
      checkedSessions.push(sessionId);
      return { session_id: sessionId, status: "running" };
    },
    createSession: async () => { throw new Error("must reuse active session"); },
    importMessages: async (sessionId, messages) => imports.push([sessionId, messages]),
    finishSession: async (sessionId, reason) => {
      finished.push([sessionId, reason]);
      return { indexing_job_id: "job-1" };
    },
    saveState: async (state) => { savedStates.push(state); return state; },
  });

  const result = await synchronizer.syncHistory(channel, {
    source_type: "discord", conversation_id: "20", oldest_cursor: "200",
    newest_cursor: "300", active_session_id: "session-before-crash",
    backfill_complete: false, tracking_enabled: true,
  });

  assert.deepEqual(checkedSessions, ["session-before-crash"]);
  assert.equal(imports[0][0], "session-before-crash");
  assert.deepEqual(finished[0], ["session-before-crash", "completed"]);
  assert.equal(result.state.oldest_cursor, "100");
  assert.equal(result.state.active_session_id, null);
  assert.equal(savedStates.at(-1).backfill_complete, true);
});

test("stopped durable session is replaced before history resumes", async () => {
  const importedSessions = [];
  const savedStates = [];
  const channel = {
    id: "20", name: "general", guildId: "10", guild: { name: "Server" },
    messages: { fetch: async () => new Map() },
  };
  const synchronizer = new DiscordBotChannelSynchronizer({
    getSession: async (sessionId) => ({ session_id: sessionId, status: "stopped" }),
    createSession: async () => ({ session_id: "replacement-session" }),
    importMessages: async (sessionId) => importedSessions.push(sessionId),
    finishSession: async () => ({ indexing_job_id: "job-2" }),
    saveState: async (state) => { savedStates.push(state); return state; },
  });

  const result = await synchronizer.syncHistory(channel, {
    source_type: "discord", conversation_id: "20", oldest_cursor: "200",
    active_session_id: "stopped-session", backfill_complete: false,
  });

  assert.equal(savedStates[0].active_session_id, null);
  assert.equal(savedStates[1].active_session_id, "replacement-session");
  assert.equal(result.state.active_session_id, null);
  assert.deepEqual(importedSessions, []);
});

test("missing durable session is replaced before synchronization", async () => {
  const savedStates = [];
  const synchronizer = new DiscordBotChannelSynchronizer({
    getSession: async () => {
      const missingSession = new Error("not found");
      missingSession.statusCode = 404;
      throw missingSession;
    },
    createSession: async () => ({ session_id: "replacement-session" }),
    saveState: async (state) => { savedStates.push(state); return state; },
  });

  const result = await synchronizer.openSession({ conversation_id: "20" }, {
    conversation_id: "20", active_session_id: "missing-session",
  });

  assert.deepEqual(savedStates.map((state) => state.active_session_id), [
    null, "replacement-session",
  ]);
  assert.equal(result.session.session_id, "replacement-session");
});
