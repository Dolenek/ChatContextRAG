class DiscordScanStallMonitor {
  constructor(options = {}) {
    this.recoveryThreshold = options.recoveryThreshold ?? 4;
    this.previousTopMessageId = null;
    this.unchangedObservationCount = 0;
  }

  record(observation, discoveredMessageCount) {
    const viewportChanged = observation.topMessageId !== this.previousTopMessageId;
    this.previousTopMessageId = observation.topMessageId;
    if (observation.atTop || viewportChanged || discoveredMessageCount > 0) {
      this.unchangedObservationCount = 0;
      return false;
    }
    this.unchangedObservationCount += 1;
    if (this.unchangedObservationCount < this.recoveryThreshold) return false;
    this.unchangedObservationCount = 0;
    return true;
  }
}

module.exports = { DiscordScanStallMonitor };
