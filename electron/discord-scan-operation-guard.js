class DiscordScanCancelledError extends Error {
  constructor() {
    super("Procházení Discordu bylo zastaveno.");
    this.name = "DiscordScanCancelledError";
  }
}

class DiscordScanOperationGuard {
  constructor(timeoutMs = 10000) {
    this.timeoutMs = timeoutMs;
    this.reset();
  }

  reset() {
    this.cancelled = false;
    this.cancellationPromise = new Promise((resolve) => {
      this.resolveCancellation = resolve;
    });
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.resolveCancellation();
  }

  async run(operationFactory, operationDescription) {
    if (this.cancelled) throw new DiscordScanCancelledError();
    let timeoutHandle;
    const timeoutPromise = new Promise((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`${operationDescription} neodpověděla do ${this.timeoutMs / 1000} s.`));
      }, this.timeoutMs);
    });
    const cancellation = this.cancellationPromise.then(() => {
      throw new DiscordScanCancelledError();
    });
    try {
      return await Promise.race([operationFactory(), cancellation, timeoutPromise]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async wait(delayMs) {
    if (this.cancelled || delayMs <= 0) return;
    let timeoutHandle;
    const delay = new Promise((resolve) => {
      timeoutHandle = setTimeout(resolve, delayMs);
    });
    await Promise.race([delay, this.cancellationPromise]);
    clearTimeout(timeoutHandle);
  }
}

module.exports = { DiscordScanCancelledError, DiscordScanOperationGuard };
