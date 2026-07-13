const {
  createMigrationBatches, sourcePagePath, sourceSnapshotPath,
} = require("./migration-batches");

class ArchiveMigrationTransfer {
  constructor(options) {
    this.sourceClient = options.sourceClient;
    this.retryPolicy = options.retryPolicy;
    this.recoverSourceBackend = options.recoverSourceBackend;
    this.persist = options.persist;
    this.isPauseRequested = options.isPauseRequested;
    this.deleteSourceSnapshot = options.deleteSourceSnapshot;
  }

  async ensureRemoteSession(state, remote) {
    if (state.remoteMigrationId) return;
    const session = await this.execute(state, {
      label: "Vytvoření migrační session", successPhase: "uploading",
    }, () => remote.post("/migrations", { total_messages: state.totalMessages }));
    state.remoteMigrationId = session.session_id;
    state.phase = "uploading";
    this.persist(state);
  }

  async transferPages(state, remote) {
    while (!this.isPauseRequested()) {
      const page = await this.fetchSourcePage(state);
      this.assertValidPage(state, page);
      for (const batch of createMigrationBatches(page.messages)) {
        if (this.isPauseRequested()) break;
        await this.uploadBatch(state, remote, batch);
      }
      if (this.isPauseRequested() || page.done) return;
    }
  }

  async fetchSourcePage(state) {
    return this.execute(state, {
      label: "Načtení exportní stránky", recoverSource: true, successPhase: "uploading",
    }, () => this.sourceClient.get(sourcePagePath(state)));
  }

  assertValidPage(state, page) {
    if (page.total_messages !== state.totalMessages) {
      throw new Error("Počet zpráv v lokálním snapshotu se neočekávaně změnil.");
    }
    if (!page.done && !page.messages.length) {
      throw new Error("Lokální API vrátilo prázdnou nedokončenou exportní stránku.");
    }
  }

  async uploadBatch(state, remote, batch) {
    const path = `/migrations/${encodeURIComponent(state.remoteMigrationId)}/messages`;
    const response = await this.execute(state, {
      label: "Odeslání migrační dávky", successPhase: "uploading",
    }, () => remote.post(path, { messages: batch }));
    if (response.accepted_count !== batch.length) {
      throw new Error(`Server potvrdil ${response.accepted_count} z ${batch.length} zpráv.`);
    }
    this.checkpointBatch(state, batch);
  }

  checkpointBatch(state, batch) {
    const acknowledgedAt = new Date().toISOString();
    state.cursor = batch.at(-1).external_id;
    state.transferredMessages = Math.min(
      state.totalMessages, state.transferredMessages + batch.length,
    );
    state.lastCheckpoint = {
      cursor: state.cursor, transferredMessages: state.transferredMessages, acknowledgedAt,
    };
    state.lastBatchAt = acknowledgedAt;
    state.phase = "uploading";
    this.persist(state);
  }

  async finalize(state, remote) {
    state.phase = "syncing";
    this.persist(state);
    await this.transferSyncStates(state, remote);
    const runningStatus = await this.remoteStatus(state, remote, "syncing");
    assertExactCount("Server", runningStatus.raw_message_count, state.totalMessages);
    if (!state.remoteCompletedAt) await this.completeRemote(state, remote);
    state.phase = "verifying";
    this.persist(state);
    await this.verifyBothSides(state, remote);
    state.phase = "cleaning_snapshot";
    this.persist(state);
    await this.deleteSnapshotWithRetry(state);
    state.snapshotDeletedAt = new Date().toISOString();
    this.persist(state);
  }

  async completeRemote(state, remote) {
    const path = `/migrations/${encodeURIComponent(state.remoteMigrationId)}/complete`;
    const completed = await this.execute(state, {
      label: "Dokončení serverové migrace", successPhase: "syncing",
    }, () => this.completeRemoteRequest(state, remote, path));
    assertExactCount("Server", completed.raw_message_count, state.totalMessages);
    state.remoteCompletedAt = new Date().toISOString();
    this.persist(state);
  }

  async completeRemoteRequest(state, remote, completionPath) {
    const statusPath = `/migrations/${encodeURIComponent(state.remoteMigrationId)}`;
    const status = await remote.get(statusPath);
    if (status.status === "completed") return status;
    return remote.post(completionPath, {});
  }

  async verifyBothSides(state, remote) {
    const snapshot = await this.execute(state, {
      label: "Ověření lokálního snapshotu", recoverSource: true, successPhase: "verifying",
    }, () => this.sourceClient.get(sourceSnapshotPath(state)));
    const remoteStatus = await this.remoteStatus(state, remote, "verifying");
    assertExactCount("Lokální snapshot", snapshot.total_messages, state.totalMessages);
    assertExactCount("Server", remoteStatus.raw_message_count, state.totalMessages);
    state.verification = {
      sourceMessages: snapshot.total_messages,
      destinationMessages: remoteStatus.raw_message_count,
      verifiedAt: new Date().toISOString(),
    };
    this.persist(state);
  }

  remoteStatus(state, remote, successPhase) {
    const path = `/migrations/${encodeURIComponent(state.remoteMigrationId)}`;
    return this.execute(state, {
      label: "Ověření serverového počtu", successPhase,
    }, () => remote.get(path));
  }

  async transferSyncStates(state, remote) {
    for (let offset = 0; offset < state.syncStates.length; offset += 200) {
      const path = `/migrations/${encodeURIComponent(state.remoteMigrationId)}/sync-states`;
      await this.execute(state, {
        label: "Přenos Discord checkpointů", successPhase: "syncing",
      }, () => remote.put(path, { states: state.syncStates.slice(offset, offset + 200) }));
    }
  }

  deleteSnapshotWithRetry(state) {
    return this.execute(state, {
      label: "Odstranění ověřeného snapshotu",
      recoverSource: true,
      successPhase: "cleaning_snapshot",
    }, () => this.deleteSourceSnapshot(state));
  }

  async execute(state, context, operation) {
    const result = await this.retryPolicy.execute(operation, {
      label: context.label,
      beforeRetry: (retry) => this.prepareRetry(state, context, retry),
    });
    if (state.retryAttempt) {
      clearRetry(state);
      state.phase = context.successPhase || state.phase;
      state.error = null;
      this.persist(state);
    }
    return result;
  }

  async prepareRetry(state, context, retry) {
    state.retryAttempt = retry.nextAttempt;
    state.maxAttempts = retry.maxAttempts;
    state.retryEndpoint = retry.error.endpoint || context.label;
    state.error = retry.error.message;
    const recover = context.recoverSource && isTimeoutError(retry.error)
      && this.recoverSourceBackend;
    state.phase = recover ? "recovering_backend" : "retrying";
    if (recover) state.lastTimeoutEndpoint = retry.error.endpoint;
    this.persist(state);
    if (!recover) return;
    await this.recover(state, retry.error);
  }

  async recover(state, timeoutError) {
    try {
      const recovery = await this.recoverSourceBackend(timeoutError);
      state.lastHealth = recovery.health;
      if (recovery.restarted) state.backendRestartedAt = recovery.restartedAt;
      if (recovery.recoveredHealth) state.recoveredHealth = recovery.recoveredHealth;
    } catch (error) {
      state.lastHealth = {
        healthy: false, endpoint: timeoutError.endpoint,
        checkedAt: new Date().toISOString(), error: error.message,
      };
      this.persist(state);
      throw error;
    }
    this.persist(state);
  }
}

function assertExactCount(label, actual, expected) {
  if (actual !== expected) {
    throw new Error(`${label} potvrdil ${actual} z ${expected} zpráv.`);
  }
}

function isTimeoutError(error) {
  return error?.code === "BACKEND_TIMEOUT";
}

function clearRetry(state) {
  delete state.retryAttempt;
  delete state.maxAttempts;
  delete state.retryEndpoint;
}

module.exports = { ArchiveMigrationTransfer, clearRetry };
