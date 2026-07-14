const assert = require("node:assert/strict");
const test = require("node:test");

const { ArchiveMigrationController } = require("../electron/archive-migration");
const {
  backendTimeout,
  generatedSourceClient,
  immediateRetryPolicy,
  memoryStore,
  message,
  rememberedConnectionStore,
  remoteClient,
  resumableState,
  sourceClient,
} = require("./archive-migration-fixtures");

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
    connectionStore,
    stateStore,
    createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({}),
    retryPolicy: immediateRetryPolicy(),
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
    sourceClient: sourceClient([message("1")], []),
    connectionStore,
    stateStore,
    createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({}),
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
    sourceClient: sourceClient([], []),
    connectionStore: rememberedConnectionStore(),
    stateStore,
    createRemoteClient: () => ({}),
    createSourceSnapshot: async () => ({}),
  });

  const status = migration.getStatus();

  assert.equal(status.phase, "interrupted");
  assert.match(status.error, /bezpe/);
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
  const remote = migrationDestination(() => remoteCount, (value) => { remoteCount = value; });
  const migration = new ArchiveMigrationController({
    sourceClient: source,
    connectionStore,
    stateStore,
    createRemoteClient: () => remote,
    createSourceSnapshot: async () => ({}),
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

function migrationDestination(getCount, setCount) {
  return {
    get: async () => ({ status: "running", raw_message_count: getCount() }),
    post: async (pathname, body) => {
      if (pathname.endsWith("/messages")) {
        setCount(getCount() + body.messages.length);
        return { accepted_count: body.messages.length };
      }
      return { status: "completed", raw_message_count: getCount() };
    },
    put: async () => ({}),
  };
}
