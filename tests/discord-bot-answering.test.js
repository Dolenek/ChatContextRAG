const assert = require("node:assert/strict");
const test = require("node:test");

const { DiscordBotAccessPolicy } = require("../electron/discord-bot-access");
const {
  detectQuestionTrigger, loadRecentDiscordContext, selectWithinBudget,
  serializedLength, MAX_RECENT_CHARACTERS,
} = require("../electron/discord-bot-context");
const {
  deliverDiscordAnswer, linkEvidenceCitations, splitDiscordMessage,
} = require("../electron/discord-bot-delivery");
const { DiscordBotQuestionHandler } = require("../electron/discord-bot-questions");
const { DiscordBotQuestionQueue } = require("../electron/discord-bot-queue");
const { DiscordBotDirectory } = require("../electron/discord-bot-directory");

test("Discord access lists stay separate and never grant an administrator bypass", () => {
  const policy = new DiscordBotAccessPolicy(() => ({ guilds: [{
    guild_id: "guild", sync_subjects: [subject("role", "sync-role")],
    ask_subjects: [subject("user", "question-user")],
  }] }));
  const administrator = member("admin", ["administrator-role"]);

  assert.equal(policy.permits(administrator, "guild", "sync"), false);
  assert.equal(policy.permits(administrator, "guild", "ask"), false);
  assert.equal(policy.permits(member("question-user"), "guild", "ask"), true);
  assert.equal(policy.permits(member("question-user"), "guild", "sync"), false);
  assert.equal(policy.permits(member("other", ["sync-role"]), "guild", "sync"), true);
});

test("question trigger accepts mentions and replies but ignores bots and DMs", async () => {
  const mention = await detectQuestionTrigger(fakeTrigger("hello <@42> world"), "42");
  const reply = fakeTrigger("follow up");
  reply.reference = { messageId: "answer" };
  reply.channel.messages.fetch = async () => ({ id: "answer", author: { id: "42" } });

  assert.deepEqual(mention, {
    triggerType: "mention", replyToMessageId: null, question: "hello world",
  });
  assert.deepEqual(await detectQuestionTrigger(reply, "42"), {
    triggerType: "reply", replyToMessageId: "answer", question: "follow up",
  });
  assert.equal(await detectQuestionTrigger({ ...fakeTrigger("<@42> hi"), guildId: null }, "42"), null);
  assert.equal(await detectQuestionTrigger({ ...fakeTrigger("<@42> hi"), author: { bot: true } }, "42"), null);
});

test("recent context is chronological, bounded, excludes the bot, and prefers newest", async () => {
  const trigger = fakeTrigger("<@42> question");
  trigger.createdTimestamp = Date.parse("2026-07-15T12:00:00Z");
  const records = [
    contextMessage("new", "2026-07-15T11:59:00Z"),
    contextMessage("bot", "2026-07-15T11:58:00Z", "42"),
    contextMessage("old", "2026-07-15T10:00:00Z"),
    ...Array.from({ length: 11 }, (_, index) => contextMessage(
      `recent-${index}`, `2026-07-15T11:${String(47 - index).padStart(2, "0")}:00Z`,
    )),
  ];
  trigger.channel.messages.fetch = async () => new Map(records.map((item) => [item.id, item]));

  const recent = await loadRecentDiscordContext(trigger, "42");

  assert.equal(recent.length, 10);
  assert.equal(recent.at(-1).message_id, "new");
  assert.equal(recent.some((item) => item.message_id === "bot"), false);
  assert.equal(recent.some((item) => item.message_id === "old"), false);
  assert.ok(serializedLength(recent) <= MAX_RECENT_CHARACTERS);
});

test("one oversized recent message is marked and truncated under the serialized limit", () => {
  const oversized = contextMessage("large", "2026-07-15T11:59:00Z");
  oversized.content = "x".repeat(10_000);

  const selected = selectWithinBudget([oversized], { channelId: "room", guildId: "guild" });

  assert.equal(selected.length, 1);
  assert.match(selected[0].content, /\[Content truncated\]$/);
  assert.ok(serializedLength(selected) <= MAX_RECENT_CHARACTERS);
});

test("per-channel queue allows one active and five pending with user cooldown", async () => {
  let finishActive;
  const activeGate = new Promise((resolve) => { finishActive = resolve; });
  const executions = [];
  const queue = new DiscordBotQuestionQueue({ now: () => 0 });
  assert.equal(queue.submit("room", "guild:first", async () => {
    executions.push("first"); await activeGate;
  }), "active");
  for (let index = 0; index < 5; index += 1) {
    assert.equal(queue.submit("room", `guild:user-${index}`, async () => {
      executions.push(`queued-${index}`);
    }), "queued");
  }
  assert.equal(queue.submit("room", "guild:overflow", async () => {}), "full");
  assert.equal(queue.submit("other", "guild:first", async () => {}), "cooldown");
  finishActive();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(executions, ["first", ...Array.from({ length: 5 }, (_, i) => `queued-${i}`)]);
});

test("unauthorized questions react without making an AI call", async () => {
  let aiCalls = 0;
  const reactions = [];
  const handler = new DiscordBotQuestionHandler({
    api: { answerDiscordQuestion: async () => { aiCalls += 1; } },
    getSettings: () => ({ guilds: [] }),
  });
  const message = fakeTrigger("<@42> secret?");
  message.react = async (emoji) => reactions.push(emoji);

  assert.equal(await handler.handle(message, "42"), true);
  assert.deepEqual(reactions, ["🚫"]);
  assert.equal(aiCalls, 0);
});

test("Discord delivery maps valid citations and splits every message safely", () => {
  const linked = linkEvidenceCitations("Podklad [E1], neplatný [E2].", [{
    evidence_id: "E1", guild_id: "10", channel_id: "20", message_id: "30",
  }]);
  assert.match(linked, /\[E1\]\(https:\/\/discord\.com\/channels\/10\/20\/30\)/);
  assert.match(linked, /\[E2\]/);
  const parts = splitDiscordMessage(`${"word ".repeat(900)}end`);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 2_000));
  assert.equal(parts.join(" ").replace(/\s+/g, " ").trim().endsWith("end"), true);
});

test("directory marks deleted roles and members unavailable without dropping them", async () => {
  const guild = {
    roles: { fetch: async () => new Map([["role-live", {}]]) },
    members: {
      cache: new Map(),
      fetch: async () => new Map([["user-live", {}]]),
    },
  };
  const directory = new DiscordBotDirectory({
    api: {}, getClient: () => ({
      isReady: () => true, guilds: { cache: new Map([["guild", guild]]) },
    }),
  });
  const subjects = [
    subject("role", "role-live"), subject("role", "role-deleted"),
    subject("user", "user-live"), subject("user", "user-deleted"),
  ];

  assert.deepEqual(await directory.subjectAvailability("guild", subjects), [
    { subject_id: "role-live", subject_type: "role", available: true },
    { subject_id: "role-deleted", subject_type: "role", available: false },
    { subject_id: "user-live", subject_type: "user", available: true },
    { subject_id: "user-deleted", subject_type: "user", available: false },
  ]);
});

test("partial Discord delivery exposes sent IDs for the failure audit", async () => {
  const trigger = {
    reply: async () => ({ id: "sent-first" }),
    channel: { send: async () => { throw new Error("missing thread permission"); } },
  };
  const answer = `${"x".repeat(2_000)} ${"y".repeat(20)}`;

  await assert.rejects(
    () => deliverDiscordAnswer(trigger, { answer, evidence: [] }),
    (error) => {
      assert.deepEqual(error.sentMessageIds, ["sent-first"]);
      return true;
    },
  );
});

function subject(subjectType, subjectId) {
  return { subject_type: subjectType, subject_id: subjectId, display_name: subjectId };
}

function member(id, roleIds = []) {
  return { id, user: { id }, roles: { cache: new Map(roleIds.map((roleId) => [roleId, {}])) } };
}

function fakeTrigger(content) {
  const users = { has: (id) => content.includes(`<@${id}>`) };
  return {
    id: "trigger", content, guildId: "guild", channelId: "room",
    author: { id: "user", username: "Ada", bot: false }, member: member("user"),
    guild: { name: "Workspace" }, mentions: { users }, createdAt: new Date(),
    createdTimestamp: Date.now(), channel: { name: "general", messages: {} },
  };
}

function contextMessage(id, timestamp, authorId = "user") {
  const createdAt = new Date(timestamp);
  return {
    id, content: id, createdAt, createdTimestamp: createdAt.getTime(),
    author: { id: authorId, username: `author-${id}` },
    member: { displayName: `Author ${id}` }, attachments: new Map(),
    channelId: "room", guildId: "guild",
  };
}
