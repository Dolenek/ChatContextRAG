const { ArchiveMigrationTransfer, clearRetry } = require("./archive-migration-transfer");
const { createMigrationBatches } = require("./migration-batches");
const { MigrationRetryPolicy } = require("./migration-retry");

const MIGRATION_PROTOCOL_VERSION = 1;
const ACTIVE_PHASES = new Set([
  "preparing", "uploading", "pausing", "retrying", "recovering_backend",
  "syncing", "verifying", "cleaning_snapshot",
]);

class ArchiveMigrationController {
  constructor(options) {
    this.sourceClient = options.sourceClient;
    this.connectionStore = options.connectionStore;
    this.stateStore = options.stateStore;
    this.createRemoteClient = options.createRemoteClient;
    this.createSourceSnapshot = options.createSourceSnapshot;
    this.recoverSourceBackend = options.recoverSourceBackend;
    this.onProgress = options.onProgress || (() => {});
    this.retryPolicy = options.retryPolicy || new MigrationRetryPolicy();
    this.pauseRequested = false;
    this.runningPromise = null;
    this.transferAgent = new ArchiveMigrationTransfer({
      sourceClient: this.sourceClient,
      retryPolicy: this.retryPolicy,
      recoverSourceBackend: this.recoverSourceBackend,
      persist: (state) => this.persist(state),
      isPauseRequested: () => this.pauseRequested,
      deleteSourceSnapshot: (state) => this.deleteSourceSnapshot(state),
    });
    this.interruptOrphanedState();
  }

  async inspect(input) {
    this.assertAvailable();
    const target = this.connectionStore.resolveRemote(input);
    const remote = this.createRemoteClient(target);
    const [runtime, sourceOverview, destinationOverview] = await Promise.all([
      remote.get("/runtime"),
      this.sourceClient.get("/database/overview?limit=1&offset=0"),
      remote.get("/database/overview?limit=1&offset=0"),
    ]);
    assertCompatibleRuntime(runtime);
    return {
      baseUrl: target.baseUrl,
      sourceMessages: sourceOverview.total_source_messages,
      destinationMessages: destinationOverview.total_source_messages,
      protocolVersion: runtime.migrationProtocolVersion,
    };
  }

  async start(input) {
    this.assertAvailable();
    if (this.runningPromise) throw new Error("Archive migration is already running.");
    const existing = this.stateStore.load();
    if (existing && existing.phase !== "completed") {
      throw new Error("An unfinished archive migration already exists. Resume or forget it.");
    }
    await this.inspect(input);
    this.connectionStore.rememberRemote(input);
    const target = this.connectionStore.resolveRemote({ baseUrl: input.baseUrl });
    const snapshot = await this.createSourceSnapshot();
    const state = this.initialState(target.baseUrl, snapshot);
    this.persist(state);
    return this.run(state);
  }

  async resume() {
    this.assertAvailable();
    if (this.runningPromise) return this.runningPromise;
    const state = this.requireState();
    if (state.phase === "completed") return publicStatus(state);
    state.phase = "uploading";
    state.error = null;
    clearRetry(state);
    this.persist(state);
    return this.run(state);
  }

  pause() {
    const state = this.requireState();
    if (state.phase === "completed") return publicStatus(state);
    this.pauseRequested = true;
    this.onProgress({ ...publicStatus(state), phase: "pausing" });
    return { ...publicStatus(state), phase: "pausing" };
  }

  getStatus() {
    if (!this.sourceClient) return { available: false, phase: "unavailable" };
    if (!this.runningPromise) this.interruptOrphanedState();
    const state = this.stateStore.load();
    return state ? publicStatus(state) : { available: true, phase: "idle" };
  }

  async index() {
    const state = this.requireState();
    if (state.phase !== "completed" || !state.remoteMigrationId) {
      throw new Error("Archive migration must finish before indexing.");
    }
    const remote = this.remoteClient(state.baseUrl);
    const session = await remote.post(
      `/migrations/${encodeURIComponent(state.remoteMigrationId)}/index`, {},
    );
    state.indexingJobIds = session.indexing_job_ids || [];
    if (state.indexingJobIds.length) state.indexingQueuedAt = new Date().toISOString();
    else delete state.indexingQueuedAt;
    this.persist(state);
    return publicStatus(state);
  }

  async forget() {
    this.pauseRequested = true;
    if (this.runningPromise) await this.runningPromise.catch(() => {});
    const state = this.stateStore.load();
    if (!state) return { available: Boolean(this.sourceClient), phase: "idle" };
    await this.closeRemoteSession(state).catch(() => {});
    await this.deleteSourceSnapshot(state).catch(() => {});
    this.stateStore.clear();
    return { available: Boolean(this.sourceClient), phase: "idle" };
  }

  initialState(baseUrl, snapshot) {
    return {
      phase: "preparing",
      baseUrl,
      localExportId: snapshot.export_id,
      remoteMigrationId: null,
      totalMessages: snapshot.total_messages,
      transferredMessages: 0,
      cursor: null,
      syncStates: snapshot.syncStates || [],
      createdAt: new Date().toISOString(),
      error: null,
    };
  }

  run(state) {
    this.pauseRequested = false;
    this.runningPromise = this.transfer(state).finally(() => {
      this.runningPromise = null;
    });
    return this.runningPromise;
  }

  async transfer(state) {
    try {
      if (state.snapshotDeletedAt) return this.markCompleted(state);
      const remote = this.remoteClient(state.baseUrl);
      await this.transferAgent.ensureRemoteSession(state, remote);
      await this.transferAgent.transferPages(state, remote);
      if (this.pauseRequested) return this.markPaused(state);
      await this.transferAgent.finalize(state, remote);
      return this.markCompleted(state);
    } catch (error) {
      state.phase = "failed";
      state.error = error.message;
      this.persist(state);
      throw error;
    }
  }

  async closeRemoteSession(state) {
    if (!state.remoteMigrationId || state.remoteCompletedAt || state.phase === "completed") return;
    const remote = this.remoteClient(state.baseUrl);
    await remote.post(
      `/migrations/${encodeURIComponent(state.remoteMigrationId)}/complete`, {},
    );
  }

  deleteSourceSnapshot(state) {
    if (!state.localExportId || !this.sourceClient || state.snapshotDeletedAt) {
      return Promise.resolve();
    }
    return this.sourceClient.delete(
      `/internal/migration-exports/${encodeURIComponent(state.localExportId)}`,
    );
  }

  markPaused(state) {
    state.phase = "paused";
    this.persist(state);
    return publicStatus(state);
  }

  markCompleted(state) {
    state.phase = "completed";
    state.completedAt ||= new Date().toISOString();
    state.error = null;
    clearRetry(state);
    this.persist(state);
    return publicStatus(state);
  }

  interruptOrphanedState() {
    const state = this.stateStore.load();
    if (!state || !ACTIVE_PHASES.has(state.phase) || this.runningPromise) return;
    state.phase = "interrupted";
    state.error = "Předchozí přenos byl přerušen. Můžete bezpečně pokračovat z checkpointu.";
    state.interruptedAt = new Date().toISOString();
    state.updatedAt = state.interruptedAt;
    this.stateStore.save(state);
  }

  remoteClient(baseUrl) {
    const target = this.connectionStore.resolveRemote({ baseUrl });
    return this.createRemoteClient(target);
  }

  persist(state) {
    state.updatedAt = new Date().toISOString();
    this.stateStore.save(state);
    this.onProgress(publicStatus(state));
  }

  requireState() {
    const state = this.stateStore.load();
    if (!state) throw new Error("No archive migration is available.");
    return state;
  }

  assertAvailable() {
    if (!this.sourceClient) {
      throw new Error("Archive migration is available only in Local mode.");
    }
  }
}

function assertCompatibleRuntime(runtime) {
  if (!runtime.migrationImport
    || runtime.migrationProtocolVersion !== MIGRATION_PROTOCOL_VERSION) {
    throw new Error("The Linux server does not support this archive migration protocol.");
  }
}

function publicStatus(state) {
  const { syncStates: _syncStates, ...visible } = state;
  return { available: true, ...visible };
}

module.exports = {
  ArchiveMigrationController, MIGRATION_PROTOCOL_VERSION,
  createMigrationBatches, publicStatus,
};
