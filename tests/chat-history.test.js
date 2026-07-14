const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("sidebar exposes new chat and direct recent conversations only when expanded", () => {
  const html = read("renderer/index.html");
  const styles = read("renderer/chat-history.css");

  assert.match(html, /id="new-chat-button"[^>]+aria-label="Nový chat"/);
  assert.match(html, /id="recent-chats-heading">Nedávné/);
  assert.match(html, /id="recent-chat-list"/);
  assert.match(html, /id="open-chat-sources-button"[^>]*>[\s\S]*?Zdroje<\/button>/);
  assert.doesNotMatch(html, /id="open-chat-button"/);
  assert.doesNotMatch(html, /id="web-logout-button"/);
  assert.match(html, /id="settings-logout-button" class="settings-nav-item hidden"/);
  assert.match(styles, /body:not\(\.navigation-expanded\) \.recent-chats/);
});

test("chat session UI supports restore, read-only fallback, rename, and custom delete", () => {
  const html = read("renderer/index.html");
  const controller = read("renderer/chat-controller.js");
  const history = read("renderer/chat-history-ui.js");

  assert.match(controller, /getChatSession\(sessionId\)/);
  assert.match(controller, /restoreScope\(session.scope\)/);
  assert.match(controller, /restoreSelection\(/);
  assert.match(controller, /session\.reasoning_effort/);
  assert.match(controller, /Chat zůstává jen pro čtení/);
  assert.match(history, /listChatSessions\(10\)/);
  assert.match(history, /renameChatSession/);
  assert.match(history, /deleteChatSession/);
  assert.match(html, /id="rename-chat-dialog"[\s\S]*id="rename-chat-input"/);
  assert.match(html, /id="delete-chat-dialog"[\s\S]*id="confirm-delete-chat"/);
});

test("chat history is bridged through Electron and the web facade", () => {
  const preload = read("electron/preload.js");
  const main = read("electron/main.js");
  const webBridge = read("renderer/runtime-bridge.js");
  const webRouter = read("web/api-router.js");

  for (const method of [
    "listChatSessions", "getChatSession", "renameChatSession", "deleteChatSession",
  ]) {
    assert.match(preload, new RegExp(`${method}:`));
    assert.match(webBridge, new RegExp(`${method}:`));
  }
  assert.match(main, /chat-sessions:list/);
  assert.match(main, /chat-sessions:rename/);
  assert.match(webRouter, /\["GET \/api\/chat\/sessions", "\/chat\/sessions"\]/);
  assert.match(webRouter, /\["GET", "PATCH", "DELETE"\]/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
