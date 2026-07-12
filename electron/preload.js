const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatContext", {
  openDiscord: () => ipcRenderer.invoke("discord:open"),
  openDiscordSource: (source) => ipcRenderer.invoke("discord:source:open", source),
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
  askDatabase: (question, history, scope) =>
    ipcRenderer.invoke("database:ask", { question, history, scope }),
  getChatScopes: () => ipcRenderer.invoke("database:chat-scopes"),
  getDatabaseOverview: (limit, offset) =>
    ipcRenderer.invoke("database:overview", { limit, offset }),
  clearDatabase: (confirmation) =>
    ipcRenderer.invoke("database:clear", { confirmation }),
  retryIndexingJob: (jobId) => ipcRenderer.invoke("indexing:retry", jobId),
  cancelIndexingJob: (jobId) => ipcRenderer.invoke("indexing:cancel", jobId),
  getIndexingJob: (jobId) => ipcRenderer.invoke("indexing:get", jobId),
  indexPendingMessages: () => ipcRenderer.invoke("indexing:pending"),
  getDiscordBotStatus: () => ipcRenderer.invoke("discord-bot:status"),
  connectDiscordBot: (token) => ipcRenderer.invoke("discord-bot:connect", token),
  disconnectDiscordBot: () => ipcRenderer.invoke("discord-bot:disconnect"),
  inviteDiscordBot: () => ipcRenderer.invoke("discord-bot:invite"),
  onDiscordBotProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("discord-bot:progress", listener);
    return () => ipcRenderer.removeListener("discord-bot:progress", listener);
  },
  selectWhatsAppExport: () => ipcRenderer.invoke("whatsapp:select"),
  previewWhatsAppExport: (options) => ipcRenderer.invoke("whatsapp:preview", options),
  importWhatsAppExport: (options) => ipcRenderer.invoke("whatsapp:import", options),
  getWhatsAppConversations: () => ipcRenderer.invoke("whatsapp:conversations"),
});
