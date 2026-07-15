const { contextBridge, ipcRenderer } = require("electron");

function createRequestId() {
  return globalThis.crypto.randomUUID();
}

function createChatRequest(question, history, scope, chatSelection, sessionId) {
  return {
    question, history, scope,
    chat_provider_id: chatSelection.providerId,
    chat_model: chatSelection.model,
    ...(chatSelection.reasoningEffort
      ? { reasoning_effort: chatSelection.reasoningEffort } : {}),
    retrieval_mode: chatSelection.retrievalMode || "deterministic",
    ...(chatSelection.retrievalMode === "adaptive"
      ? { evidence_character_limit: chatSelection.evidenceCharacterLimit } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

function askDatabaseStreaming(question, history, scope, selection, sessionId, onActivity) {
  const requestId = createRequestId();
  const listener = (_event, progress) => {
    if (progress.requestId === requestId) onActivity(progress.record);
  };
  ipcRenderer.on("database:chat-progress", listener);
  const request = createChatRequest(question, history, scope, selection, sessionId);
  return ipcRenderer.invoke("database:ask-stream", { requestId, request })
    .finally(() => ipcRenderer.removeListener("database:chat-progress", listener));
}

contextBridge.exposeInMainWorld("chatContext", {
  getRuntimeCapabilities: () => ipcRenderer.invoke("runtime:capabilities"),
  getConnectionTarget: () => ipcRenderer.invoke("connection:get"),
  testConnectionTarget: (target) => ipcRenderer.invoke("connection:test", target),
  saveConnectionTarget: (target) => ipcRenderer.invoke("connection:save", target),
  inspectArchiveMigration: (target) => ipcRenderer.invoke("migration:inspect", target),
  startArchiveMigration: (target) => ipcRenderer.invoke("migration:start", target),
  pauseArchiveMigration: () => ipcRenderer.invoke("migration:pause"),
  resumeArchiveMigration: () => ipcRenderer.invoke("migration:resume"),
  getArchiveMigrationStatus: () => ipcRenderer.invoke("migration:status"),
  indexArchiveMigration: () => ipcRenderer.invoke("migration:index"),
  forgetArchiveMigration: () => ipcRenderer.invoke("migration:forget"),
  onArchiveMigrationProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("migration:progress", listener);
    return () => ipcRenderer.removeListener("migration:progress", listener);
  },
  openDiscord: () => ipcRenderer.invoke("discord:open"),
  captureDiscord: () => ipcRenderer.invoke("discord:capture"),
  startDiscordScan: () => ipcRenderer.invoke("discord:scan:start"),
  resumeDiscordScan: () => ipcRenderer.invoke("discord:scan:resume"),
  stopDiscordScan: () => ipcRenderer.invoke("discord:scan:stop"),
  onDiscordScanProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("discord:scan:progress", listener);
    return () => ipcRenderer.removeListener("discord:scan:progress", listener);
  },
  onIndexingProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("discord:index:progress", listener);
    return () => ipcRenderer.removeListener("discord:index:progress", listener);
  },
  hideDiscord: () => ipcRenderer.invoke("discord:hide"),
  askDatabase: (question, history, scope, chatSelection = {}, sessionId = null) =>
    ipcRenderer.invoke("database:ask", createChatRequest(
      question, history, scope, chatSelection, sessionId,
    )),
  askDatabaseStreaming: askDatabaseStreaming,
  getChatScopes: () => ipcRenderer.invoke("database:chat-scopes"),
  listChatSessions: (limit = 10) => ipcRenderer.invoke("chat-sessions:list", limit),
  getChatSession: (sessionId) => ipcRenderer.invoke("chat-sessions:get", sessionId),
  renameChatSession: (sessionId, title) =>
    ipcRenderer.invoke("chat-sessions:rename", { sessionId, title }),
  deleteChatSession: (sessionId) => ipcRenderer.invoke("chat-sessions:delete", sessionId),
  getDatabaseOverview: (limit, offset) =>
    ipcRenderer.invoke("database:overview", { limit, offset }),
  getDatabaseStatus: (options = {}) => ipcRenderer.invoke("database:status", options),
  refreshReadModel: (scope = "active") =>
    ipcRenderer.invoke("database:read-model-refresh", scope),
  getDatabaseBreakdowns: () => ipcRenderer.invoke("database:breakdowns"),
  getDatabaseBreakdownPage: (dimension, limit = 50, offset = 0) =>
    ipcRenderer.invoke("database:breakdown-page", { dimension, limit, offset }),
  getDatabaseChunkPage: (limit, cursor = null) =>
    ipcRenderer.invoke("database:chunks", { limit, cursor }),
  clearDatabase: (confirmation) =>
    ipcRenderer.invoke("database:clear", { confirmation }),
  retryIndexingJob: (jobId) => ipcRenderer.invoke("indexing:retry", jobId),
  cancelIndexingJob: (jobId) => ipcRenderer.invoke("indexing:cancel", jobId),
  getIndexingJob: (jobId) => ipcRenderer.invoke("indexing:get", jobId),
  getActiveIndexingJobs: () => ipcRenderer.invoke("indexing:active"),
  indexPendingMessages: () => ipcRenderer.invoke("indexing:pending"),
  getDiscordBotStatus: () => ipcRenderer.invoke("discord-bot:status"),
  connectDiscordBot: (token) => ipcRenderer.invoke("discord-bot:connect", token),
  pauseDiscordBot: () => ipcRenderer.invoke("discord-bot:pause"),
  resumeDiscordBot: () => ipcRenderer.invoke("discord-bot:resume"),
  disconnectDiscordBot: () => ipcRenderer.invoke("discord-bot:disconnect"),
  inviteDiscordBot: () => ipcRenderer.invoke("discord-bot:invite"),
  getDiscordBotSettings: () => ipcRenderer.invoke("discord-bot:settings"),
  updateDiscordBotModel: (model) => ipcRenderer.invoke("discord-bot:model:update", model),
  updateDiscordGuildPermissions: (permissions) =>
    ipcRenderer.invoke("discord-bot:permissions:update", permissions),
  getDiscordGuildRoles: (guildId) => ipcRenderer.invoke("discord-bot:roles", guildId),
  searchDiscordGuildMembers: (guildId, query) =>
    ipcRenderer.invoke("discord-bot:members", guildId, query),
  getDiscordSubjectAvailability: (guildId, subjects) =>
    ipcRenderer.invoke("discord-bot:subjects", guildId, subjects),
  listDiscordBotAnswers: (query) => ipcRenderer.invoke("discord-bot:answers", query),
  getDiscordBotAnswer: (answerId) => ipcRenderer.invoke("discord-bot:answer", answerId),
  deleteDiscordBotAnswer: (answerId) =>
    ipcRenderer.invoke("discord-bot:answer:delete", answerId),
  deleteDiscordBotAnswers: (guildId = null) =>
    ipcRenderer.invoke("discord-bot:answers:delete", guildId),
  onDiscordBotProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("discord-bot:progress", listener);
    return () => ipcRenderer.removeListener("discord-bot:progress", listener);
  },
  selectWhatsAppExport: () => ipcRenderer.invoke("whatsapp:select"),
  previewWhatsAppExport: (options) => ipcRenderer.invoke("whatsapp:preview", options),
  importWhatsAppExport: (options) => ipcRenderer.invoke("whatsapp:import", options),
  getWhatsAppConversations: () => ipcRenderer.invoke("whatsapp:conversations"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveProvider: (profile) => ipcRenderer.invoke("settings:provider:save", profile),
  deleteProvider: (providerId) => ipcRenderer.invoke("settings:provider:delete", providerId),
  listProviderModels: (providerId) => ipcRenderer.invoke("settings:models", providerId),
  saveChatDefault: (providerId, model) =>
    ipcRenderer.invoke("settings:chat-default", { providerId, model }),
  saveChatModel: (model) => ipcRenderer.invoke("settings:chat-model:save", model),
  deleteChatModel: (providerId, model) =>
    ipcRenderer.invoke("settings:chat-model:delete", { providerId, model }),
  updateWorkspaceSettings: (timezoneName) =>
    ipcRenderer.invoke("settings:workspace:update", timezoneName),
  createEmbeddingIndex: (input) => ipcRenderer.invoke("settings:index:create", input),
  updateEmbeddingIndex: (indexId, update) =>
    ipcRenderer.invoke("settings:index:update", { indexId, update }),
  activateEmbeddingIndex: (indexId) => ipcRenderer.invoke("settings:index:activate", indexId),
  syncEmbeddingIndex: (indexId) => ipcRenderer.invoke("settings:index:sync", indexId),
  rebuildEmbeddingIndex: (indexId) => ipcRenderer.invoke("settings:index:rebuild", indexId),
  deleteEmbeddingIndex: (indexId) => ipcRenderer.invoke("settings:index:delete", indexId),
});
