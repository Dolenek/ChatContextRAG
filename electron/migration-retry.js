class MigrationRetryPolicy {
  constructor(options = {}) {
    this.maxAttempts = options.maxAttempts || 3;
    this.delaysMs = options.delaysMs || [1_000, 2_000];
    this.wait = options.wait || wait;
  }

  async execute(operation, hooks = {}) {
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        return await operation(attempt);
      } catch (error) {
        if (attempt === this.maxAttempts) {
          throw exhaustedError(error, this.maxAttempts, hooks.label);
        }
        const retry = {
          error,
          nextAttempt: attempt + 1,
          maxAttempts: this.maxAttempts,
          delayMs: this.delaysMs[attempt - 1] || this.delaysMs.at(-1) || 0,
        };
        await hooks.beforeRetry?.(retry);
        await this.wait(retry.delayMs);
      }
    }
    throw new Error("Migration retry policy ended unexpectedly.");
  }
}

function exhaustedError(error, attempts, label = "Požadavek") {
  const exhausted = new Error(`${label} selhal po ${attempts} pokusech: ${error.message}`);
  exhausted.name = "MigrationRetryError";
  exhausted.code = error.code || "MIGRATION_RETRIES_EXHAUSTED";
  exhausted.endpoint = error.endpoint;
  exhausted.cause = error;
  return exhausted;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { MigrationRetryPolicy };
