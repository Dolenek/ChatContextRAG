const test = require("node:test");
const assert = require("node:assert/strict");

const { DiscordChannelScanner } = require("../electron/discord-channel-scanner");

test("scanner imports unseen messages until the top of a channel", async () => {
  const steps = [
    { messages: [{ external_id: "2" }, { external_id: "3" }], atTop: false, topMessageId: "2" },
    { messages: [{ external_id: "1" }, { external_id: "2" }], atTop: true, topMessageId: "1" },
  ];
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => script.includes("requestedScrollTop")
      ? { requestedScrollTop: 100 }
      : steps.shift(),
  };
  const importedBatches = [];
  const scanner = new DiscordChannelScanner(
    webContents, { delayMs: 0, requiredTopConfirmations: 1 },
  );

  const summary = await scanner.start(async (messages) => {
    importedBatches.push(messages.map((message) => message.external_id));
    return { imported_count: messages.length, chunk_count: 1 };
  }, () => {});

  assert.deepEqual(importedBatches, [["2", "3"], ["1"]]);
  assert.equal(summary.importedMessages, 3);
  assert.equal(summary.state, "completed");
});

test("scanner keeps retrying unchanged views until a confirmed channel start", async () => {
  const observations = [
    { messages: [{ external_id: "2" }], atTop: false, topMessageId: "2" },
    ...Array.from({ length: 8 }, () => ({ messages: [], atTop: false, topMessageId: "2" })),
    { messages: [{ external_id: "1" }], atTop: true, topMessageId: "1" },
    { messages: [{ external_id: "1" }], atTop: true, topMessageId: "1" },
  ];
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => script.includes("requestedScrollTop")
      ? { requestedScrollTop: 0 }
      : observations.shift(),
  };
  const scanner = new DiscordChannelScanner(
    webContents, { delayMs: 0, requiredTopConfirmations: 2 },
  );

  const summary = await scanner.start(async (messages) => ({
    imported_count: messages.length, chunk_count: 1,
  }), () => {});

  assert.equal(summary.discoveredMessages, 2);
  assert.equal(summary.state, "completed");
});
