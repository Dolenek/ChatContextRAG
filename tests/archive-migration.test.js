const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ArchiveMigrationController,
  createMigrationBatches,
} = require("../electron/archive-migration");
const {
  backendTimeout,
  exportPage,
  immediateRetryPolicy,
  memoryStore,
  message,
  rememberedConnectionStore,
  remoteClient,
  resumableState,
  sourceClient,
} = require("./archive-migration-fixtures");

test("archive migration checkpoints, pauses, resumes, verifies, and indexes explicitly", async () => {
  const messages = [message("1"), message("2"), message("3")];
  const imported = new Set();
  const remoteCalls = [];
  const sourceDeletes = [];
  let releaseBatch;
  let announceBatch;
  const batchStarted = new Promise((resolve) => { announceBatch = resolve; });
  const batchGate = new Promise((resolve) => { releaseBatch = resolve; });
  const source = sourceClient(messages, sourceDeletes);
  const remote = remoteClient(imported, remoteCalls, async () => {
    announceBatch();
    await batchGate;
  });
  const stateStore = memoryStore();
  const connectionStore = rememberedConnectionStore();
  const progress = [];
  const migration = new ArchiveMigrationController({
    sourceClient: source,
    connectionStore,
    stateStore,
    createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({
      export_id: "export-1",
      total_messages: 3,
      syncStates: [{ source_type: "discord", conversation_id: "20" }],
    }),
    onProgress: (status) => progress.push(status),
  });

  const running = migration.start({ baseUrl: "http://server:8080", token: "secret" });
  await batchStarted;
  assert.equal(migration.pause().phase, "pausing");
  releaseBatch();
  const paused = await running;

  assert.equal(paused.phase, "paused");
  assert.equal(paused.transferredMessages, 3);
  assert.equal(stateStore.load().cursor, "3");
  const completed = await migration.resume();
  assert.equal(completed.phase, "completed");
  assert.equal(imported.size, 3);
  assert.deepEqual(sourceDeletes, ["/internal/migration-exports/export-1"]);
  assert.equal(remoteCalls.some((call) => call[0].endsWith("/complete")), true);
  assert.equal(remoteCalls.some((call) => call[0].endsWith("/index")), false);
  assert.equal(progress.at(-1).syncStates, undefined);

  const indexed = await migration.index();
  assert.deepEqual(indexed.indexingJobIds, ["job-1"]);
  assert.equal(remoteCalls.some((call) => call[0].endsWith("/index")), true);
});

test("migration batches respect both message-count and serialized-size limits", () => {
  const countBatches = createMigrationBatches(
    Array.from({ length: 401 }, (_, index) => message(String(index))),
  );
  const sizeBatches = createMigrationBatches(
    Array.from({ length: 100 }, (_, index) => message(String(index), "x".repeat(20000))),
  );

  assert.deepEqual(countBatches.map((batch) => batch.length), [400, 1]);
  assert.equal(sizeBatches.length > 1, true);
  for (const batch of sizeBatches) {
    assert.equal(Buffer.byteLength(JSON.stringify({ messages: batch })) <= 1_500_000, true);
  }
  assert.throws(
    () => createMigrationBatches([message("oversized", "x".repeat(1_500_000))]),
    /exceeds the migration upload limit/,
  );
});

test("migration refuses an incompatible server and a changed resume target", async () => {
  const connectionStore = rememberedConnectionStore();
  const migration = new ArchiveMigrationController({
    sourceClient: sourceClient([], []),
    connectionStore,
    stateStore: memoryStore({
      phase: "paused",
      baseUrl: "http://other:8080",
      localExportId: "export",
      remoteMigrationId: "migration",
      totalMessages: 0,
      transferredMessages: 0,
      cursor: null,
      syncStates: [],
    }),
    createRemoteClient: () => ({
      get: async (pathname) => pathname === "/runtime"
        ? { migrationImport: false, migrationProtocolVersion: 1 }
        : { total_source_messages: 0 },
    }),
    createSourceSnapshot: async () => ({}),
  });

  await assert.rejects(
    migration.inspect({ baseUrl: "http://server:8080", token: "secret" }),
    /does not support/,
  );
  connectionStore.rememberRemote({ baseUrl: "http://server:8080", token: "secret" });
  await assert.rejects(migration.resume(), /token is unavailable for this server/);
});

test("a frozen local page restarts the backend and resumes from the saved cursor", async () => {
  const timeout = backendTimeout("http://127.0.0.1:8765/internal/export/messages");
  const stateStore = memoryStore(resumableState(2, 1, "1"));
  const connectionStore = rememberedConnectionStore();
  connectionStore.rememberRemote({ baseUrl: "http://server:8080", token: "secret" });
  const imported = new Set(["1"]);
  const progress = [];
  let pageAttempts = 0;
  let recoveryCalls = 0;
  const source = {
    get: async (pathname) => {
      if (pathname === "/internal/migration-exports/export-1") {
        return { export_id: "export-1", total_messages: 2 };
      }
      pageAttempts += 1;
      if (pageAttempts === 1) throw timeout;
      return exportPage([message("2")], 2, true);
    },
    delete: async () => ({ deleted: true }),
  };
  const migration = new ArchiveMigrationController({
    sourceClient: source,
    connectionStore,
    stateStore,
    createRemoteClient: () => remoteClient(imported, [], async () => {}),
    createSourceSnapshot: async () => ({}),
    retryPolicy: immediateRetryPolicy(),
    recoverSourceBackend: async (error) => {
      recoveryCalls += 1;
      assert.equal(error.endpoint, timeout.endpoint);
      return {
        health: { healthy: false, endpoint: "http://127.0.0.1:8765/health" },
        recoveredHealth: { healthy: true, endpoint: "http://127.0.0.1:8765/health" },
        restarted: true,
        restartedAt: new Date().toISOString(),
      };
    },
    onProgress: (status) => progress.push(status),
  });

  const completed = await migration.resume();

  assert.equal(completed.phase, "completed");
  assert.equal(completed.transferredMessages, 2);
  assert.equal(imported.size, 2);
  assert.equal(pageAttempts, 2);
  assert.equal(recoveryCalls, 1);
  assert.ok(progress.some((status) => status.phase === "recovering_backend"));
  assert.equal(completed.lastHealth.healthy, false);
});
