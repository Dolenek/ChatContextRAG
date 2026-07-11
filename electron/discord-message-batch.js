function takeChronologicalBatch(pendingMessages, batchSize) {
  return [...pendingMessages.values()]
    .sort((left, right) => compareMessageIds(left.external_id, right.external_id))
    .slice(0, batchSize);
}

function compareMessageIds(leftId, rightId) {
  if (!/^\d+$/.test(leftId) || !/^\d+$/.test(rightId)) {
    return leftId.localeCompare(rightId);
  }
  const leftSnowflake = BigInt(leftId);
  const rightSnowflake = BigInt(rightId);
  if (leftSnowflake < rightSnowflake) return -1;
  if (leftSnowflake > rightSnowflake) return 1;
  return 0;
}

module.exports = { takeChronologicalBatch };
