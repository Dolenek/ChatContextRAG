const { pathToFileURL } = require("node:url");

function createTrustedIpcMain(ipcMain, getMainWindow, rendererFile) {
  const trustedRendererUrl = pathToFileURL(rendererFile).href;
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...arguments_) => {
        if (!isTrustedSender(event, getMainWindow(), trustedRendererUrl)) {
          throw new Error("Rejected IPC request from an untrusted renderer.");
        }
        return listener(event, ...arguments_);
      });
    },
  };
}

function isTrustedSender(event, mainWindow, trustedRendererUrl) {
  return Boolean(
    mainWindow
    && event?.sender === mainWindow.webContents
    && event?.senderFrame?.url === trustedRendererUrl,
  );
}

module.exports = { createTrustedIpcMain, isTrustedSender };
