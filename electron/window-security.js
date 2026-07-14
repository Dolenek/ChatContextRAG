const { pathToFileURL } = require("node:url");

function secureMainWindow(browserWindow, rendererFile) {
  const trustedRendererUrl = pathToFileURL(rendererFile).href;
  blockUntrustedNavigation(
    browserWindow.webContents,
    (targetUrl) => targetUrl === trustedRendererUrl,
  );
  browserWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  denyAllPermissions(browserWindow.webContents.session);
}

function secureDiscordView(webContents, persistentSession) {
  denyAllPermissions(persistentSession);
  blockUntrustedNavigation(webContents, isDiscordUrl);
  webContents.setWindowOpenHandler(({ url }) => {
    if (isDiscordUrl(url)) void webContents.loadURL(url);
    return { action: "deny" };
  });
}

function blockUntrustedNavigation(webContents, isAllowed) {
  const preventUntrustedTarget = (event, targetUrl) => {
    if (!isAllowed(targetUrl)) event.preventDefault();
  };
  webContents.on("will-navigate", preventUntrustedTarget);
  webContents.on("will-redirect", preventUntrustedTarget);
}

function denyAllPermissions(targetSession) {
  targetSession?.setPermissionCheckHandler?.(() => false);
  targetSession?.setPermissionRequestHandler?.((_contents, _permission, callback) => {
    callback(false);
  });
}

function isDiscordUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://discord.com"
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

module.exports = { denyAllPermissions, isDiscordUrl, secureDiscordView, secureMainWindow };
