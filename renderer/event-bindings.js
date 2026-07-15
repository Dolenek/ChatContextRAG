async function showChatWorkspace() {
  await window.chatController.open();
}

async function showDatabaseOverview() {
  window.shellController.showScreen("overview");
  window.shellController.closeDrawer();
  const databaseLoad = window.overviewController.open();
  await window.appUi.closeDiscordView(false);
  await databaseLoad;
}

document.querySelector("#open-discord-button")
  .addEventListener("click", window.appUi.openDiscord);
document.querySelector("#capture-button")
  .addEventListener("click", captureDiscordMessages);
document.querySelector("#scan-channel-button")
  .addEventListener("click", toggleChannelScan);
document.querySelector("#resume-scan-button")
  .addEventListener("click", resumeChannelScan);
document.querySelector("#close-discord-button")
  .addEventListener("click", () => window.appUi.closeDiscordView());
document.querySelector("#open-sources-button")
  .addEventListener("click", () => window.shellController.openDrawerPanel("sources"));
document.querySelector("#open-overview-button")
  .addEventListener("click", showDatabaseOverview);
document.querySelector("#open-settings-button")
  .addEventListener("click", window.settingsUi.open);
document.querySelector("#chat-after-import-button")
  .addEventListener("click", showChatWorkspace);
document.querySelector("#chat-form")
  .addEventListener("submit", window.chatController.submitQuestion);
document.querySelector("#new-chat-button")
  .addEventListener("click", window.chatController.startNewChat);
document.querySelector("#refresh-overview-button")
  .addEventListener("click", window.overviewController.refresh);
document.querySelector("#load-more-chunks-button")
  .addEventListener("click", window.overviewController.loadMore);
document.querySelector("#open-clear-database-button")
  .addEventListener("click", window.appUi.openClearDatabaseDialog);
document.querySelector("#cancel-clear-button")
  .addEventListener("click", window.appUi.closeClearDatabaseDialog);
document.querySelector("#clear-confirmation-input")
  .addEventListener("input", window.appUi.updateClearConfirmation);
document.querySelector("#confirm-clear-button")
  .addEventListener("click", window.appUi.clearDatabase);

window.indexingControls.bind({
  refreshOverview: async () => {
    window.overviewController.markDatabaseChanged();
    await window.overviewController.refreshStatus({ forceClient: true });
  },
  refreshTerminal: window.overviewController.refreshAfterTerminal,
  showToast: window.appUi.showToast,
});
window.chatController.bind({ showToast: window.appUi.showToast });
window.chatHistoryUi.bind({
  openSession: window.chatController.restoreSession,
  showToast: window.appUi.showToast,
  startNewChat: window.chatController.startNewChat,
});
window.chatScopeSelector.bind(window.chatController.resetConversation);
window.conversationView.bindComposer();
window.modelSelector.bind({
  resetConversation: window.chatController.resetConversation,
  showToast: window.appUi.showToast,
});
window.retrievalModeSelector.bind({
  resetConversation: window.chatController.resetConversation,
});
window.settingsUi.bind({
  prepareOpen: async () => {
    await window.appUi.closeDiscordView(false);
    window.shellController.closeResponsiveNavigation();
    window.shellController.closeDrawer();
    window.shellController.closeContext();
  },
  resetConversation: window.chatController.resetConversation,
  showToast: window.appUi.showToast,
});
window.discordBotUi.bind({
  openSettings: window.settingsUi.open,
  showToast: window.appUi.showToast,
});
window.whatsappImportUi.bind({
  openDrawerPanel: window.shellController.openDrawerPanel,
  refreshWorkspaceData: window.appUi.refreshWorkspaceData,
  showImportResult: window.appUi.showImportResult,
  showToast: window.appUi.showToast,
});

window.shellController.showScreen("chat");
void Promise.all([
  window.runtimeCapabilitiesUi.refresh()
    .catch((error) => window.appUi.showToast(error.message, true)),
  window.appUi.refreshWorkspaceData(),
  window.modelSelector.prepare().catch((error) => window.appUi.showToast(error.message, true)),
  window.chatHistoryUi.refresh(),
]);
