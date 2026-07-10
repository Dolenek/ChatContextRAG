const {
  buildDiscordScanObservationScript,
  buildDiscordScrollUpScript,
} = require("./discord-extractor");

class DiscordChannelScanner {
  constructor(webContents, options = {}) {
    this.webContents = webContents;
    this.delayMs = options.delayMs ?? 1100;
    this.requiredTopConfirmations = options.requiredTopConfirmations ?? 12;
    this.running = false;
    this.cancelRequested = false;
  }

  async start(importMessages, reportProgress) {
    if (this.running) throw new Error("Procházení kanálu už běží.");
    const channelUrl = this.webContents.getURL();
    this.validateChannelUrl(channelUrl);
    this.running = true;
    this.cancelRequested = false;
    const summary = this.createSummary();
    const seenMessageIds = new Set();
    try {
      await this.runUntilStopped(channelUrl, seenMessageIds, summary, importMessages, reportProgress);
      return { ...summary, state: this.cancelRequested ? "stopped" : "completed" };
    } finally {
      this.running = false;
      reportProgress({ ...summary, state: this.cancelRequested ? "stopped" : summary.state });
    }
  }

  stop() {
    this.cancelRequested = true;
  }

  async runUntilStopped(channelUrl, seenIds, summary, importMessages, reportProgress) {
    let topCandidateId = null;
    let topConfirmationCount = 0;
    while (!this.cancelRequested) {
      if (this.webContents.getURL() !== channelUrl) {
        await this.waitForOriginalChannel(summary, reportProgress);
        continue;
      }
      try {
        const observation = await this.observeMessages();
        const newMessages = observation.messages.filter(
          (message) => !seenIds.has(message.external_id),
        );
        await this.importAndMark(newMessages, seenIds, summary, importMessages);
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
        await this.scrollAndWait();
      } catch (error) {
        await this.waitAfterError(error, summary, reportProgress);
      }
    }
  }

  async observeMessages() {
    const observation = await this.webContents.executeJavaScript(
      buildDiscordScanObservationScript(), true,
    );
    if (observation.error) throw new Error(observation.error);
    return observation;
  }

  async importAndMark(messages, seenIds, summary, importMessages) {
    if (!messages.length) return;
    const result = await importMessages(messages);
    messages.forEach((message) => seenIds.add(message.external_id));
    summary.discoveredMessages += messages.length;
    summary.importedMessages += result.imported_count;
    summary.storedChunks += result.chunk_count;
  }

  updateTopConfirmation(observation, newMessages, candidateId, confirmationCount) {
    if (!observation.atTop) return [null, 0];
    const sameCandidate = observation.topMessageId === candidateId;
    const stable = sameCandidate && newMessages.length === 0;
    return [observation.topMessageId, stable ? confirmationCount + 1 : 1];
  }

  async scrollAndWait() {
    const result = await this.webContents.executeJavaScript(buildDiscordScrollUpScript(), true);
    if (result.error) throw new Error(result.error);
    await this.waitForDiscord();
  }

  async waitForOriginalChannel(summary, reportProgress) {
    summary.state = "waiting-channel";
    summary.lastError = "Vraťte se do původního kanálu, nebo procházení zastavte.";
    reportProgress({ ...summary });
    await this.waitForDiscord();
  }

  async waitAfterError(error, summary, reportProgress) {
    summary.state = "retrying";
    summary.retryCount += 1;
    summary.lastError = error.message || "Dočasná chyba při procházení.";
    reportProgress({ ...summary });
    await this.waitForDiscord();
  }

  waitForDiscord() {
    return new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  validateChannelUrl(url) {
    if (!/^https:\/\/discord\.com\/channels\/[^/]+\/[^/]+/.test(url)) {
      throw new Error("Nejdřív v Discordu otevřete konkrétní kanál nebo konverzaci.");
    }
  }

  createSummary() {
    return {
      discoveredMessages: 0, importedMessages: 0, storedChunks: 0,
      retryCount: 0, lastError: null, state: "running",
    };
  }
}

module.exports = { DiscordChannelScanner };
