const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { requireDiscordInviteUrl } = require("../electron/discord-url");
const {
  assertRemoteTransportSecurity, isLoopbackHostname,
  requiresInsecureHttpAcknowledgement,
} = require("../electron/connection-security");
const { createTrustedIpcMain } = require("../electron/ipc-security");
const {
  isDiscordUrl, secureDiscordView, secureMainWindow,
} = require("../electron/window-security");

test("IPC handlers accept only the main local renderer frame", () => {
  let registeredHandler;
  const ipcMain = { handle: (_channel, handler) => { registeredHandler = handler; } };
  const webContents = {};
  const mainWindow = { webContents };
  const rendererFile = path.resolve(__dirname, "..", "renderer", "index.html");
  const rendererUrl = pathToFileURL(rendererFile).href;
  const trustedIpc = createTrustedIpcMain(ipcMain, () => mainWindow, rendererFile);
  trustedIpc.handle("secure-operation", (_event, value) => value);

  assert.equal(registeredHandler({ sender: webContents, senderFrame: { url: rendererUrl } }, 7), 7);
  assert.throws(
    () => registeredHandler({ sender: webContents, senderFrame: { url: "https://evil.test" } }),
    /untrusted renderer/,
  );
});

test("main window blocks navigation, popups, and permissions", () => {
  const controls = fakeWebContents();
  const rendererFile = path.resolve(__dirname, "..", "renderer", "index.html");
  secureMainWindow({ webContents: controls.webContents }, rendererFile);

  assert.deepEqual(controls.windowOpenHandler(), { action: "deny" });
  const navigationEvent = preventableEvent();
  controls.handlers["will-navigate"](navigationEvent, "https://evil.test/");
  assert.equal(navigationEvent.prevented, true);
  const redirectEvent = preventableEvent();
  controls.handlers["will-redirect"](redirectEvent, "https://evil.test/");
  assert.equal(redirectEvent.prevented, true);
  assert.equal(controls.permissionCheckHandler(), false);
  let permissionDecision;
  controls.permissionRequestHandler({}, "camera", (allowed) => {
    permissionDecision = allowed;
  });
  assert.equal(permissionDecision, false);
});

test("Discord view allows only HTTPS Discord navigation and trusted invites", () => {
  const controls = fakeWebContents();
  secureDiscordView(controls.webContents, controls.session);
  assert.equal(isDiscordUrl("https://discord.com/app"), true);
  assert.equal(isDiscordUrl("https://discord.com.evil.test/app"), false);
  assert.equal(isDiscordUrl("https://discord.com:8443/app"), false);
  const navigationEvent = preventableEvent();
  controls.handlers["will-navigate"](navigationEvent, "https://evil.test/");
  assert.equal(navigationEvent.prevented, true);
  const redirectEvent = preventableEvent();
  controls.handlers["will-redirect"](redirectEvent, "https://evil.test/");
  assert.equal(redirectEvent.prevented, true);
  assert.match(
    requireDiscordInviteUrl("https://discord.com/oauth2/authorize?client_id=1"),
    /^https:\/\/discord\.com\/oauth2\/authorize/,
  );
  assert.throws(() => requireDiscordInviteUrl("file:///tmp/payload"), /not trusted/);
  assert.throws(
    () => requireDiscordInviteUrl("https://discord.com:8443/oauth2/authorize"),
    /not trusted/,
  );
});

test("remote HTTP requires acknowledgement while loopback HTTP stays available", () => {
  assert.equal(isLoopbackHostname("localhost"), true);
  assert.equal(isLoopbackHostname("127.42.0.8"), true);
  assert.equal(isLoopbackHostname("::1"), true);
  assert.equal(requiresInsecureHttpAcknowledgement("http://192.168.1.20:8080"), true);
  assert.equal(requiresInsecureHttpAcknowledgement("http://127.0.0.1:8080"), false);
  assert.equal(requiresInsecureHttpAcknowledgement("https://server.example"), false);
  assert.throws(
    () => assertRemoteTransportSecurity("http://server.example", false),
    /explicit acknowledgement/,
  );
  assert.doesNotThrow(
    () => assertRemoteTransportSecurity("http://server.example", true),
  );
});

test("Electron dependency stays on the supported v43 release line", () => {
  const projectRoot = path.resolve(__dirname, "..");
  const manifest = require(path.join(projectRoot, "package.json"));
  const lockfile = require(path.join(projectRoot, "package-lock.json"));

  assert.equal(manifest.devDependencies.electron, "^43.1.1");
  assert.equal(lockfile.packages["node_modules/electron"].version, "43.1.1");
});

function fakeWebContents() {
  const controls = { handlers: {}, session: {} };
  controls.session.setPermissionCheckHandler = (handler) => { controls.permissionCheckHandler = handler; };
  controls.session.setPermissionRequestHandler = (handler) => { controls.permissionRequestHandler = handler; };
  controls.webContents = {
    session: controls.session,
    on: (event, handler) => { controls.handlers[event] = handler; },
    setWindowOpenHandler: (handler) => { controls.windowOpenHandler = handler; },
    loadURL: async () => {},
  };
  return controls;
}

function preventableEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}
