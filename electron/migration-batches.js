const MAX_BATCH_MESSAGES = 400;
const MAX_BATCH_BYTES = 1_500_000;
const EMPTY_BATCH_BYTES = Buffer.byteLength('{"messages":[]}');

function sourcePagePath(state) {
  const query = new URLSearchParams({ limit: String(MAX_BATCH_MESSAGES) });
  if (state.cursor) query.set("after_external_id", state.cursor);
  return `${sourceSnapshotPath(state)}/messages?${query}`;
}

function sourceSnapshotPath(state) {
  return `/internal/migration-exports/${encodeURIComponent(state.localExportId)}`;
}

function createMigrationBatches(messages) {
  const batches = [];
  let current = [];
  let currentBytes = EMPTY_BATCH_BYTES;
  for (const message of messages) {
    const messageBytes = Buffer.byteLength(JSON.stringify(message));
    const addedBytes = messageBytes + (current.length ? 1 : 0);
    if (!current.length && currentBytes + addedBytes > MAX_BATCH_BYTES) {
      throw new Error(`Message ${message.external_id} exceeds the migration upload limit.`);
    }
    if (current.length && currentBytes + addedBytes > MAX_BATCH_BYTES) {
      batches.push(current);
      current = [];
      currentBytes = EMPTY_BATCH_BYTES;
    }
    current.push(message);
    currentBytes += messageBytes + (current.length > 1 ? 1 : 0);
    if (current.length === MAX_BATCH_MESSAGES) {
      batches.push(current);
      current = [];
      currentBytes = EMPTY_BATCH_BYTES;
    }
  }
  if (current.length) batches.push(current);
  return batches;
}

module.exports = {
  MAX_BATCH_BYTES, MAX_BATCH_MESSAGES, createMigrationBatches,
  sourcePagePath, sourceSnapshotPath,
};
