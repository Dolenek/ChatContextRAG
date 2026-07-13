const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ArchiveMigrationController, createMigrationBatches,
} = require("../electron/archive-migration");
const { MigrationRetryPolicy } = require("../electron/migration-retry");

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
    sourceClient: source, connectionStore, stateStore,
    createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({
      export_id: "export-1", total_messages: 3,
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
    sourceClient: sourceClient([], []), connectionStore,
    stateStore: memoryStore({
      phase: "paused", baseUrl: "http://other:8080", localExportId: "export",
      remoteMigrationId: "migration", totalMessages: 0, transferredMessages: 0,
      cursor: null, syncStates: [],
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
    sourceClient: source, connectionStore, stateStore,
    createRemoteClient: () => remoteClient(imported, [], async () => {}),
    createSourceSnapshot: async () => ({}),
    retryPolicy: immediateRetryPolicy(),
    recoverSourceBackend: async (error) => {
      recoveryCalls += 1;
      assert.equal(error.endpoint, timeout.endpoint);
      return {
        health: { healthy: false, endpoint: "http://127.0.0.1:8765/health" },
        recoveredHealth: { healthy: true, endpoint: "http://127.0.0.1:8765/health" },
        restarted: true, restartedAt: new Date().toISOString(),
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

test("a repeated acknowledged batch is idempotent and checkpoints only after its reply", async () => {
  const stateStore = memoryStore(resumableState(2));
  const connectionStore = rememberedConnectionStore();
  connectionStore.rememberRemote({ baseUrl: "http://server:8080", token: "secret" });
  const imported = new Set();
  let uploadAttempts = 0;
  const remote = remoteClient(imported, [], async () => {
    uploadAttempts += 1;
    if (uploadAttempts === 1) {
      imported.add("1");
      imported.add("2");
      assert.equal(stateStore.load().cursor, null);
      throw backendTimeout("http://server:8080/api/migrations/migration-1/messages");
    }
  });
  const migration = new ArchiveMigrationController({
    sourceClient: sourceClient([message("1"), message("2")], []),
    connectionStore, stateStore, createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({}), retryPolicy: immediateRetryPolicy(),
  });

  const completed = await migration.resume();

  assert.equal(completed.phase, "completed");
  assert.equal(uploadAttempts, 2);
  assert.equal(imported.size, 2);
  assert.equal(completed.cursor, "2");
  assert.equal(completed.transferredMessages, 2);
});

test("desktop completion recovers a lost reply even when the server route is not idempotent", async () => {
  const stateStore = memoryStore(resumableState(1));
  const connectionStore = rememberedConnectionStore();
  connectionStore.rememberRemote({ baseUrl: "http://server:8080", token: "secret" });
  let remoteCount = 0;
  let remoteStatus = "running";
  let completionCalls = 0;
  const remote = {
    get: async () => ({ status: remoteStatus, raw_message_count: remoteCount }),
    post: async (pathname, body) => {
      if (pathname.endsWith("/messages")) {
        remoteCount += body.messages.length;
        return { accepted_count: body.messages.length };
      }
      completionCalls += 1;
      remoteStatus = "completed";
      throw backendTimeout("http://server:8080/api/migrations/migration-1/complete");
    },
    put: async () => ({}),
  };
  const migration = new ArchiveMigrationController({
    sourceClient: sourceClient([message("1")], []), connectionStore, stateStore,
    createRemoteClient: () => remote, createSourceSnapshot: async () => ({}),
    retryPolicy: immediateRetryPolicy(),
  });

  const completed = await migration.resume();

  assert.equal(completed.phase, "completed");
  assert.equal(completionCalls, 1);
  assert.equal(completed.verification.destinationMessages, 1);
});

test("Electron startup turns orphaned uploading into an interrupted resumable state", () => {
  const stateStore = memoryStore({ ...resumableState(10, 4, "4"), phase: "uploading" });
  const migration = new ArchiveMigrationController({
    sourceClient: sourceClient([], []), connectionStore: rememberedConnectionStore(),
    stateStore, createRemoteClient: () => ({}), createSourceSnapshot: async () => ({}),
  });

  const status = migration.getStatus();

  assert.equal(status.phase, "interrupted");
  assert.match(status.error, /bezpečně pokračovat/);
  assert.equal(status.cursor, "4");
});

test("a 200,000-message migration verifies exact counts before deleting its snapshot", async () => {
  const totalMessages = 200_000;
  const stateStore = memoryStore(resumableState(totalMessages));
  const connectionStore = rememberedConnectionStore();
  connectionStore.rememberRemote({ baseUrl: "http://server:8080", token: "secret" });
  let remoteCount = 0;
  let snapshotDeleted = false;
  const source = generatedSourceClient(totalMessages, () => {
    assert.deepEqual(stateStore.load().verification, {
      sourceMessages: totalMessages,
      destinationMessages: totalMessages,
      verifiedAt: stateStore.load().verification.verifiedAt,
    });
    snapshotDeleted = true;
  });
  const remote = {
    get: async () => ({ status: "running", raw_message_count: remoteCount }),
    post: async (pathname, body) => {
      if (pathname.endsWith("/messages")) {
        remoteCount += body.messages.length;
        return { accepted_count: body.messages.length };
      }
      return { status: "completed", raw_message_count: remoteCount };
    },
    put: async () => ({}),
  };
  const migration = new ArchiveMigrationController({
    sourceClient: source, connectionStore, stateStore,
    createRemoteClient: () => remote, createSourceSnapshot: async () => ({}),
    retryPolicy: immediateRetryPolicy(),
  });

  const completed = await migration.resume();

  assert.equal(completed.phase, "completed");
  assert.equal(completed.transferredMessages, totalMessages);
  assert.equal(completed.verification.sourceMessages, totalMessages);
  assert.equal(completed.verification.destinationMessages, totalMessages);
  assert.equal(remoteCount, totalMessages);
  assert.equal(snapshotDeleted, true);
});

function message(externalId, content = `message ${externalId}`) {
  return { external_id: externalId, author: "Ada", content, source_type: "discord" };
}

function sourceClient(messages, deletes) {
  return {
    get: async (pathname) => {
      if (pathname.startsWith("/database/overview")) return { total_source_messages: messages.length };
      if (pathname === "/internal/migration-exports/export-1") {
        return { export_id: "export-1", total_messages: messages.length };
      }
      const url = new URL(pathname, "http://local");
      const cursor = url.searchParams.get("after_external_id");
      const page = messages.filter((item) => !cursor || item.external_id > cursor);
      return {
        export_id: "export-1", total_messages: messages.length,
        messages: page.slice(0, 400), next_cursor: page.at(399)?.external_id,
        done: page.length <= 400,
      };
    },
    delete: async (pathname) => { deletes.push(pathname); return { deleted: true }; },
  };
}

function remoteClient(imported, calls, beforeImport) {
  return {
    get: async (pathname) => {
      if (pathname === "/runtime") {
        return { migrationImport: true, migrationProtocolVersion: 1 };
      }
      if (pathname.startsWith("/database/overview")) return { total_source_messages: 2 };
      return { session_id: "migration-1", status: "running", raw_message_count: imported.size };
    },
    post: async (pathname, body) => {
      calls.push([pathname, body]);
      if (pathname === "/migrations") return { session_id: "migration-1", status: "running" };
      if (pathname.endsWith("/messages")) {
        await beforeImport();
        body.messages.forEach((item) => imported.add(item.external_id));
        return { accepted_count: body.messages.length };
      }
      if (pathname.endsWith("/index")) return { indexing_job_ids: ["job-1"] };
      return {
        status: "completed", raw_message_count: imported.size, indexing_job_ids: [],
      };
    },
    put: async (pathname, body) => { calls.push([pathname, body]); return body; },
  };
}

function resumableState(totalMessages, transferredMessages = 0, cursor = null) {
  return {
    phase: "paused", baseUrl: "http://server:8080", localExportId: "export-1",
    remoteMigrationId: "migration-1", totalMessages, transferredMessages,
    cursor, syncStates: [], error: null,
  };
}

function exportPage(messages, totalMessages, done) {
  return {
    export_id: "export-1", total_messages: totalMessages, messages,
    next_cursor: messages.at(-1)?.external_id, done,
  };
}

function backendTimeout(endpoint) {
  return Object.assign(new Error("Lokální API neodpovědělo do 30 sekund."), {
    code: "BACKEND_TIMEOUT", endpoint,
  });
}

function immediateRetryPolicy() {
  return new MigrationRetryPolicy({ delaysMs: [0, 0], wait: async () => {} });
}

function generatedSourceClient(totalMessages, onDelete) {
  return {
    get: async (pathname) => {
      if (pathname === "/internal/migration-exports/export-1") {
        return { export_id: "export-1", total_messages: totalMessages };
      }
      const cursor = new URL(pathname, "http://local")
        .searchParams.get("after_external_id");
      const start = cursor ? Number(cursor) + 1 : 1;
      const end = Math.min(totalMessages, start + 399);
      const messages = Array.from(
        { length: Math.max(0, end - start + 1) },
        (_, offset) => message(String(start + offset).padStart(6, "0")),
      );
      return exportPage(messages, totalMessages, end >= totalMessages);
    },
    delete: async () => { onDelete(); return { deleted: true }; },
  };
}

function memoryStore(initial = null) {
  let state = initial ? structuredClone(initial) : null;
  return {
    load: () => state ? structuredClone(state) : null,
    save: (value) => { state = structuredClone(value); return value; },
    clear: () => { state = null; },
  };
}

function rememberedConnectionStore() {
  let remembered = null;
  return {
    rememberRemote: (input) => { remembered = { baseUrl: input.baseUrl, token: input.token }; },
    resolveRemote: (input) => {
      if (input.token) return { baseUrl: input.baseUrl, token: input.token };
      if (!remembered || remembered.baseUrl !== input.baseUrl) {
        throw new Error("Remote token is unavailable for this server.");
      }
      return remembered;
    },
  };
}
