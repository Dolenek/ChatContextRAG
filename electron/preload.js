const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("chatContext", {
  openDiscord: () => ipcRenderer.invoke("discord:open"),
  captureDiscord: () => ipcRenderer.invoke("discord:capture"),
  hideDiscord: () => ipcRenderer.invoke("discord:hide"),
  askDatabase: (question) => ipcRenderer.invoke("database:ask", question),
});
