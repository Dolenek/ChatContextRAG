function createScanSummary() {
  return {
    discoveredMessages: 0, importedMessages: 0, storedChunks: 0,
    pendingMessages: 0, retryCount: 0, lastError: null, state: "running",
  };
}

function getChannelRoute(url) {
  const match = url.match(/^(https:\/\/discord\.com\/channels\/[^/]+\/[^/]+)/);
  if (!match) {
    throw new Error("Nejdřív v Discordu otevřete konkrétní kanál nebo konverzaci.");
  }
  return match[1];
}

function isCurrentChannel(webContents, expectedRoute) {
  try {
    return getChannelRoute(webContents.getURL()) === expectedRoute;
  } catch (_error) {
    return false;
  }
}

function findUnseenMessages(observation, seenIds, pendingMessages) {
  return observation.messages.filter(
    (message) => !seenIds.has(message.external_id)
      && !pendingMessages.has(message.external_id),
  );
}

function updateTopConfirmation(observation, discoveredCount, scanState) {
  if (!observation.atTop) {
    scanState.topCandidateId = null;
    scanState.topConfirmationCount = 0;
    return;
  }
  const sameCandidate = observation.topMessageId === scanState.topCandidateId;
  scanState.topCandidateId = observation.topMessageId;
  scanState.topConfirmationCount = sameCandidate && discoveredCount === 0
    ? scanState.topConfirmationCount + 1
    : 1;
}

module.exports = {
  createScanSummary, findUnseenMessages, getChannelRoute,
  isCurrentChannel, updateTopConfirmation,
};
