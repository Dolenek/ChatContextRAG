const MAX_BATCH_MESSAGES = 400;
const MAX_BATCH_BYTES = 1_500_000;
const MIGRATION_PROTOCOL_VERSION = 1;

class ArchiveMigrationController {
  constructor(options) {
    this.sourceClient = options.sourceClient;
    this.connectionStore = options.connectionStore;
    this.stateStore = options.stateStore;
    this.createRemoteClient = options.createRemoteClient;
    this.createSourceSnapshot = options.createSourceSnapshot;
    this.onProgress = options.onProgress || (() => {});
    this.pauseRequested = false;
    this.runningPromise = null;
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
    if (state.indexingJobIds.length) {
      state.indexingQueuedAt = new Date().toISOString();
    } else {
      delete state.indexingQueuedAt;
    }
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
      phase: "preparing", baseUrl,
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
      const remote = this.remoteClient(state.baseUrl);
      await this.ensureRemoteSession(state, remote);
      await this.transferPages(state, remote);
      if (this.pauseRequested) return this.markPaused(state);
      return await this.finalize(state, remote);
    } catch (error) {
      state.phase = "failed";
      state.error = error.message;
      this.persist(state);
      throw error;
    }
  }

  async ensureRemoteSession(state, remote) {
    if (state.remoteMigrationId) return;
    const session = await remote.post("/migrations", {
      total_messages: state.totalMessages,
    });
    state.remoteMigrationId = session.session_id;
    state.phase = "uploading";
    this.persist(state);
  }

  async transferPages(state, remote) {
    while (!this.pauseRequested) {
      const page = await this.sourcePage(state);
      for (const batch of createMigrationBatches(page.messages)) {
        if (this.pauseRequested) break;
        await remote.post(
          `/migrations/${encodeURIComponent(state.remoteMigrationId)}/messages`,
          { messages: batch },
        );
        state.cursor = batch.at(-1).external_id;
        state.transferredMessages = Math.min(
          state.totalMessages, state.transferredMessages + batch.length,
        );
        state.phase = "uploading";
        this.persist(state);
      }
      if (this.pauseRequested || page.done) return;
    }
  }

  sourcePage(state) {
    const query = new URLSearchParams({ limit: String(MAX_BATCH_MESSAGES) });
    if (state.cursor) query.set("after_external_id", state.cursor);
    return this.sourceClient.get(
      `/internal/migration-exports/${encodeURIComponent(state.localExportId)}/messages?${query}`,
    );
  }

  async finalize(state, remote) {
    state.phase = "syncing";
    this.persist(state);
    await this.transferSyncStates(state, remote);
    const status = await remote.get(
      `/migrations/${encodeURIComponent(state.remoteMigrationId)}`,
    );
    if (status.raw_message_count !== state.totalMessages) {
      throw new Error(
        `Server confirmed ${status.raw_message_count} of ${state.totalMessages} messages.`,
      );
    }
    await remote.post(
      `/migrations/${encodeURIComponent(state.remoteMigrationId)}/complete`, {},
    );
    await this.deleteSourceSnapshot(state);
    state.phase = "completed";
    state.completedAt = new Date().toISOString();
    state.error = null;
    this.persist(state);
    return publicStatus(state);
  }

  async transferSyncStates(state, remote) {
    for (let offset = 0; offset < state.syncStates.length; offset += 200) {
      await remote.put(
        `/migrations/${encodeURIComponent(state.remoteMigrationId)}/sync-states`,
        { states: state.syncStates.slice(offset, offset + 200) },
      );
    }
  }

  async closeRemoteSession(state) {
    if (!state.remoteMigrationId || state.phase === "completed") return;
    const remote = this.remoteClient(state.baseUrl);
    await remote.post(
      `/migrations/${encodeURIComponent(state.remoteMigrationId)}/complete`, {},
    );
  }

  deleteSourceSnapshot(state) {
    if (!state.localExportId || !this.sourceClient) return Promise.resolve();
    return this.sourceClient.delete(
      `/internal/migration-exports/${encodeURIComponent(state.localExportId)}`,
    );
  }

  markPaused(state) {
    state.phase = "paused";
    this.persist(state);
    return publicStatus(state);
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

function createMigrationBatches(messages) {
  const batches = [];
  let current = [];
  for (const message of messages) {
    const candidate = [...current, message];
    if (!current.length && serializedBatchBytes(candidate) > MAX_BATCH_BYTES) {
      throw new Error(`Message ${message.external_id} exceeds the migration upload limit.`);
    }
    if (current.length && serializedBatchBytes(candidate) > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [message];
    } else {
      current = candidate;
    }
    if (current.length === MAX_BATCH_MESSAGES) {
      batches.push(current);
      current = [];
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

function serializedBatchBytes(messages) {
  return Buffer.byteLength(JSON.stringify({ messages }), "utf8");
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
