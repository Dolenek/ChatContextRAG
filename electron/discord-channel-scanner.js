const {
  buildDiscordScanObservationScript,
  buildDiscordScrollUpScript,
} = require("./discord-extractor");

class DiscordChannelScanner {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.scrollDelayMs = options.scrollDelayMs ?? options.delayMs ?? 180;
    this.topDelayMs = options.topDelayMs ?? options.delayMs ?? 900;
    this.retryDelayMs = options.retryDelayMs ?? options.delayMs ?? 1100;
    this.importBatchSize = options.importBatchSize ?? 400;
    this.requiredTopConfirmations = options.requiredTopConfirmations ?? 12;
    this.running = false;
    this.cancelRequested = false;
  }

  async start(importMessages, reportProgress) {
    if (this.running) throw new Error("Procházení kanálu už běží.");
    const channelRoute = this.getChannelRoute(this.webContents.getURL());
    this.running = true;
    this.cancelRequested = false;
    const summary = this.createSummary();
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
  }

  async runUntilStopped(
    channelRoute, seenIds, pendingMessages, summary, importMessages, reportProgress,
  ) {
    let topCandidateId = null;
    let topConfirmationCount = 0;
    while (!this.cancelRequested) {
      if (!this.isCurrentChannel(channelRoute)) {
        await this.waitForOriginalChannel(summary, reportProgress);
        continue;
      }
      try {
        const observation = await this.observeMessages();
        const newMessages = observation.messages.filter(
          (message) => !seenIds.has(message.external_id)
            && !pendingMessages.has(message.external_id),
        );
        this.queueMessages(newMessages, pendingMessages, summary);
        if (newMessages.length) reportProgress({ ...summary });
        await this.flushPendingMessages(
          pendingMessages, seenIds, summary, importMessages, observation.atTop,
        );
        [topCandidateId, topConfirmationCount] = this.updateTopConfirmation(
          observation, newMessages, topCandidateId, topConfirmationCount,
        );
        if (topConfirmationCount >= this.requiredTopConfirmations) {
          summary.state = "completed";
          break;
        }
        summary.state = observation.atTop ? "waiting" : "running";
        summary.lastError = null;
        reportProgress({ ...summary });
        await this.scrollAndWait(observation.atTop);
      } catch (error) {
        await this.waitAfterError(error, summary, reportProgress);
      }
    }
    await this.flushPendingMessages(
      pendingMessages, seenIds, summary, importMessages, true,
    );
  }

  async observeMessages() {
    const observation = await this.webContents.executeJavaScript(
      buildDiscordScanObservationScript(), true,
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
      const messages = this.takeChronologicalBatch(pendingMessages);
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

  takeChronologicalBatch(pendingMessages) {
    return [...pendingMessages.values()]
      .sort((left, right) => this.compareMessageIds(left.external_id, right.external_id))
      .slice(0, this.importBatchSize);
  }

  compareMessageIds(leftId, rightId) {
    if (/^\d+$/.test(leftId) && /^\d+$/.test(rightId)) {
      const left = BigInt(leftId);
      const right = BigInt(rightId);
      return left < right ? -1 : left > right ? 1 : 0;
    }
    return leftId.localeCompare(rightId);
  }

  updateTopConfirmation(observation, newMessages, candidateId, confirmationCount) {
    if (!observation.atTop) return [null, 0];
    const sameCandidate = observation.topMessageId === candidateId;
    const stable = sameCandidate && newMessages.length === 0;
    return [observation.topMessageId, stable ? confirmationCount + 1 : 1];
  }

  async scrollAndWait(atTop) {
    const result = await this.webContents.executeJavaScript(buildDiscordScrollUpScript(), true);
    if (result.error) throw new Error(result.error);
    await this.wait(atTop ? this.topDelayMs : this.scrollDelayMs);
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
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  getChannelRoute(url) {
    const match = url.match(/^(https:\/\/discord\.com\/channels\/[^/]+\/[^/]+)/);
    if (!match) {
      throw new Error("Nejdřív v Discordu otevřete konkrétní kanál nebo konverzaci.");
    }
    return match[1];
  }

  isCurrentChannel(expectedRoute) {
    try {
      return this.getChannelRoute(this.webContents.getURL()) === expectedRoute;
    } catch (_error) {
      return false;
    }
  }

  createSummary() {
    return {
      discoveredMessages: 0, importedMessages: 0, storedChunks: 0,
      pendingMessages: 0, retryCount: 0, lastError: null, state: "running",
    };
  }
}

module.exports = { DiscordChannelScanner };
