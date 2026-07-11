const {
  buildDiscordScanObservationScript,
  buildDiscordScrollUpScript,
} = require("./discord-extractor");
const { takeChronologicalBatch } = require("./discord-message-batch");
const {
  createScanSummary, findUnseenMessages, getChannelRoute,
  isCurrentChannel, updateTopConfirmation,
} = require("./discord-scan-state");
const { DiscordScanStallMonitor } = require("./discord-scan-stall-monitor");
const {
  DiscordScanCancelledError, DiscordScanOperationGuard,
} = require("./discord-scan-operation-guard");

class DiscordChannelScanner {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.scrollDelayMs = options.scrollDelayMs ?? options.delayMs ?? 180;
    this.topDelayMs = options.topDelayMs ?? options.delayMs ?? 900;
    this.retryDelayMs = options.retryDelayMs ?? options.delayMs ?? 1100;
    this.importBatchSize = options.importBatchSize ?? 400;
    this.requiredTopConfirmations = options.requiredTopConfirmations ?? 12;
    this.stallMonitorOptions = { recoveryThreshold: options.stallRecoveryThreshold };
    this.operationGuard = new DiscordScanOperationGuard(options.operationTimeoutMs);
    this.running = false;
    this.cancelRequested = false;
  }

  async start(importMessages, reportProgress) {
    if (this.running) throw new Error("Procházení kanálu už běží.");
    const channelRoute = getChannelRoute(this.webContents.getURL());
    this.running = true;
    this.cancelRequested = false;
    this.operationGuard.reset();
    const summary = createScanSummary();
    const seenMessageIds = new Set();
    const pendingMessages = new Map();
    try {
      await this.runUntilStopped(
        channelRoute, seenMessageIds, pendingMessages, summary, importMessages, reportProgress,
      );
      return { ...summary, state: this.cancelRequested ? "stopped" : "completed" };
    } finally {
      this.running = false;
      reportProgress({ ...summary, state: this.cancelRequested ? "stopped" : summary.state });
    }
  }

  stop() {
    this.cancelRequested = true;
    this.operationGuard.cancel();
  }

  async runUntilStopped(
    channelRoute, seenIds, pendingMessages, summary, importMessages, reportProgress,
  ) {
    const scanState = {
      topCandidateId: null,
      topConfirmationCount: 0,
      stallMonitor: new DiscordScanStallMonitor(this.stallMonitorOptions),
    };
    const resources = { seenIds, pendingMessages, summary, importMessages, reportProgress };
    while (!this.cancelRequested) {
      if (!isCurrentChannel(this.webContents, channelRoute)) {
        await this.waitForOriginalChannel(summary, reportProgress);
        continue;
      }
      try {
        const observation = await this.observeMessages();
        if (!await this.processObservation(observation, scanState, resources)) break;
      } catch (error) {
        if (error instanceof DiscordScanCancelledError) break;
        await this.waitAfterError(error, summary, reportProgress);
      }
    }
    await this.flushPendingMessages(
      pendingMessages, seenIds, summary, importMessages, true,
    );
  }

  async processObservation(observation, scanState, resources) {
    const { seenIds, pendingMessages, summary, importMessages, reportProgress } = resources;
    const newMessages = findUnseenMessages(observation, seenIds, pendingMessages);
    this.queueMessages(newMessages, pendingMessages, summary);
    if (newMessages.length) reportProgress({ ...summary });
    await this.flushPendingMessages(
      pendingMessages, seenIds, summary, importMessages, observation.atTop,
    );
    updateTopConfirmation(observation, newMessages.length, scanState);
    if (scanState.topConfirmationCount >= this.requiredTopConfirmations) {
      summary.state = "completed";
      summary.lastError = null;
      return false;
    }
    if (scanState.stallMonitor.record(observation, newMessages.length)) {
      await this.recoverStalledScan(
        pendingMessages, seenIds, summary, importMessages, reportProgress,
      );
      return true;
    }
    summary.state = observation.atTop ? "waiting" : "running";
    summary.lastError = null;
    reportProgress({ ...summary });
    await this.scrollAndWait(observation.atTop);
    return true;
  }

  async observeMessages() {
    const observation = await this.operationGuard.run(
      () => this.webContents.executeJavaScript(buildDiscordScanObservationScript(), true),
      "Čtení historie Discordu",
    );
    if (observation.error) throw new Error(observation.error);
    return observation;
  }

  queueMessages(messages, pendingMessages, summary) {
    messages.forEach((message) => pendingMessages.set(message.external_id, message));
    summary.discoveredMessages += messages.length;
    summary.pendingMessages = pendingMessages.size;
  }

  async flushPendingMessages(
    pendingMessages, seenIds, summary, importMessages, force,
  ) {
    while (pendingMessages.size >= this.importBatchSize || (force && pendingMessages.size)) {
      const messages = takeChronologicalBatch(pendingMessages, this.importBatchSize);
      const result = await importMessages(messages);
      messages.forEach((message) => {
        pendingMessages.delete(message.external_id);
        seenIds.add(message.external_id);
      });
      summary.importedMessages += result.imported_count;
      summary.storedChunks += result.chunk_count;
      summary.pendingMessages = pendingMessages.size;
    }
  }

  async recoverStalledScan(
    pendingMessages, seenIds, summary, importMessages, reportProgress,
  ) {
    await this.flushPendingMessages(pendingMessages, seenIds, summary, importMessages, true);
    summary.state = "recovering";
    summary.retryCount += 1;
    summary.lastError = "Discord neposunul historii; obnovuji načítání.";
    reportProgress({ ...summary });
    await this.scrollAndWait(false, true);
  }

  async scrollAndWait(atTop, recoveryMode = false) {
    const script = buildDiscordScrollUpScript(recoveryMode);
    const result = await this.operationGuard.run(
      () => this.webContents.executeJavaScript(script, true),
      "Posun historie Discordu",
    );
    if (result.error) throw new Error(result.error);
    const delayMs = recoveryMode
      ? this.retryDelayMs
      : atTop ? this.topDelayMs : this.scrollDelayMs;
    await this.wait(delayMs);
  }

  async waitForOriginalChannel(summary, reportProgress) {
    summary.state = "waiting-channel";
    summary.lastError = "Vraťte se do původního kanálu, nebo procházení zastavte.";
    reportProgress({ ...summary });
    await this.wait(this.retryDelayMs);
  }

  async waitAfterError(error, summary, reportProgress) {
    summary.state = "retrying";
    summary.retryCount += 1;
    summary.lastError = error.message || "Dočasná chyba při procházení.";
    reportProgress({ ...summary });
    await this.wait(this.retryDelayMs);
  }

  wait(delayMs) {
    return this.operationGuard.wait(delayMs);
  }

}

module.exports = { DiscordChannelScanner };
