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

  assert.deepEqual(importedBatches, [["1", "2", "3"]]);
  assert.equal(summary.importedMessages, 3);
  assert.equal(summary.state, "completed");
});

test("scanner stores full batches before reaching the channel top", async () => {
  const observations = [
    { messages: [{ external_id: "5" }, { external_id: "6" }], atTop: false, topMessageId: "5" },
    { messages: [{ external_id: "3" }, { external_id: "4" }], atTop: false, topMessageId: "3" },
    { messages: [{ external_id: "1" }, { external_id: "2" }], atTop: true, topMessageId: "1" },
  ];
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => script.includes("requestedScrollTop")
      ? { requestedScrollTop: 100 }
      : observations.shift(),
  };
  const importedBatches = [];
  const scanner = new DiscordChannelScanner(
    webContents, { delayMs: 0, requiredTopConfirmations: 1, importBatchSize: 4 },
  );

  await scanner.start(async (messages) => {
    importedBatches.push(messages.map((message) => message.external_id));
    return { imported_count: messages.length, chunk_count: 1 };
  }, () => {});

  assert.deepEqual(importedBatches, [["3", "4", "5", "6"], ["1", "2"]]);
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

test("scanner flushes pending messages and forces a scroll after a stalled viewport", async () => {
  const observations = [
    { messages: [{ external_id: "2" }], atTop: false, topMessageId: "2" },
    { messages: [{ external_id: "2" }], atTop: false, topMessageId: "2" },
    { messages: [{ external_id: "2" }], atTop: false, topMessageId: "2" },
    { messages: [{ external_id: "1" }], atTop: true, topMessageId: "1" },
  ];
  const executedScripts = [];
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => {
      executedScripts.push(script);
      return script.includes("requestedScrollTop")
        ? { requestedScrollTop: 0 }
        : observations.shift();
    },
  };
  const importedBatches = [];
  const scanner = new DiscordChannelScanner(webContents, {
    delayMs: 0, requiredTopConfirmations: 1, importBatchSize: 10,
    stallRecoveryThreshold: 2,
  });

  const summary = await scanner.start(async (messages) => {
    importedBatches.push(messages.map((message) => message.external_id));
    return { imported_count: messages.length, chunk_count: 0 };
  }, () => {});

  assert.deepEqual(importedBatches, [["2"], ["1"]]);
  assert.equal(summary.retryCount, 1);
  assert.ok(executedScripts.some((script) => script.includes("const recoveryMode = true")));
});

test("scanner accepts a Discord message deep link for the selected channel", async () => {
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel/message-id",
    executeJavaScript: async (script) => script.includes("requestedScrollTop")
      ? { requestedScrollTop: 0 }
      : { messages: [], atTop: true, topMessageId: "first" },
  };
  const scanner = new DiscordChannelScanner(
    webContents, { delayMs: 0, requiredTopConfirmations: 1 },
  );

  const summary = await scanner.start(async () => ({
    imported_count: 0, chunk_count: 0,
  }), () => {});

  assert.equal(summary.state, "completed");
});

test("stop interrupts an unresponsive Discord observation and flushes pending raw messages", async () => {
  let observationCount = 0;
  let signalSecondObservation;
  const secondObservationStarted = new Promise((resolve) => {
    signalSecondObservation = resolve;
  });
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => {
      if (script.includes("requestedScrollTop")) return { requestedScrollTop: 100 };
      observationCount += 1;
      if (observationCount === 1) {
        return { messages: [{ external_id: "1" }], atTop: false, topMessageId: "1" };
      }
      signalSecondObservation();
      return new Promise(() => {});
    },
  };
  const importedBatches = [];
  const scanner = new DiscordChannelScanner(webContents, { delayMs: 0 });
  const scan = scanner.start(async (messages) => {
    importedBatches.push(messages.map((message) => message.external_id));
    return { imported_count: messages.length, chunk_count: 0 };
  }, () => {});

  await secondObservationStarted;
  scanner.stop();
  const summary = await scan;

  assert.equal(summary.state, "stopped");
  assert.deepEqual(importedBatches, [["1"]]);
});

test("scanner retries after an unresponsive Discord operation times out", async () => {
  let observationCount = 0;
  const webContents = {
    getURL: () => "https://discord.com/channels/server/channel",
    executeJavaScript: async (script) => {
      if (script.includes("requestedScrollTop")) return { requestedScrollTop: 0 };
      observationCount += 1;
      if (observationCount === 1) return new Promise(() => {});
      return { messages: [], atTop: true, topMessageId: "first" };
    },
  };
  const scanner = new DiscordChannelScanner(webContents, {
    delayMs: 0, requiredTopConfirmations: 1, operationTimeoutMs: 1,
  });

  const summary = await scanner.start(async () => ({
    imported_count: 0, chunk_count: 0,
  }), () => {});

  assert.equal(summary.state, "completed");
  assert.equal(summary.retryCount, 1);
});
