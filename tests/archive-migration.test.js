const assert = require("node:assert/strict");
const test = require("node:test");

const {
  ArchiveMigrationController, createMigrationBatches,
} = require("../electron/archive-migration");

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

function message(externalId, content = `message ${externalId}`) {
  return { external_id: externalId, author: "Ada", content, source_type: "discord" };
}

function sourceClient(messages, deletes) {
  return {
    get: async (pathname) => {
      if (pathname.startsWith("/database/overview")) return { total_source_messages: messages.length };
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
      return { status: "completed", indexing_job_ids: [] };
    },
    put: async (pathname, body) => { calls.push([pathname, body]); return body; },
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
