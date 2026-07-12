document.querySelector("#open-discord-button").addEventListener("click", openDiscord);
document.querySelector("#capture-button").addEventListener("click", captureDiscordMessages);
document.querySelector("#scan-channel-button").addEventListener("click", toggleChannelScan);
document.querySelector("#resume-scan-button").addEventListener("click", resumeChannelScan);
document.querySelector("#open-chat-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#open-overview-button").addEventListener("click", openDatabaseOverview);
document.querySelector("#chat-after-import-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#import-more-button").addEventListener("click", openDiscord);
document.querySelector("#chat-form").addEventListener("submit", submitQuestion);
document.querySelector("#refresh-overview-button").addEventListener("click", openDatabaseOverview);
document.querySelector("#load-more-chunks-button").addEventListener("click", () => {
  loadDatabaseOverview(true);
});
document.querySelector("#open-clear-database-button")
  .addEventListener("click", openClearDatabaseDialog);
document.querySelector("#cancel-clear-button").addEventListener("click", closeClearDatabaseDialog);
document.querySelector("#clear-confirmation-input")
  .addEventListener("input", updateClearConfirmation);
document.querySelector("#confirm-clear-button").addEventListener("click", clearDatabase);
window.indexingControls.bind({ refreshOverview: openDatabaseOverview, showToast });
document.querySelector("#home-button").addEventListener("click", async () => {
  await window.chatContext.hideDiscord();
  showScreen("home");
});

window.chatContext.onDiscordScanProgress(renderScanProgress);
window.chatContext.onIndexingProgress(renderIndexingProgress);
