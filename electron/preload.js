const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatContext", {
  openDiscord: () => ipcRenderer.invoke("discord:open"),
  captureDiscord: () => ipcRenderer.invoke("discord:capture"),
  startDiscordScan: () => ipcRenderer.invoke("discord:scan:start"),
  stopDiscordScan: () => ipcRenderer.invoke("discord:scan:stop"),
  onDiscordScanProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("discord:scan:progress", listener);
    return () => ipcRenderer.removeListener("discord:scan:progress", listener);
  },
  hideDiscord: () => ipcRenderer.invoke("discord:hide"),
  askDatabase: (question, history) => ipcRenderer.invoke("database:ask", { question, history }),
  getDatabaseOverview: (limit, offset) =>
    ipcRenderer.invoke("database:overview", { limit, offset }),
  clearDatabase: (confirmation) =>
    ipcRenderer.invoke("database:clear", { confirmation }),
});
