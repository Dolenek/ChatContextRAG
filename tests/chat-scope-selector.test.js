const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("chat scope selector is wired from UI through Electron to the API", () => {
  const html = read("renderer/index.html");
  const selector = read("renderer/chat-scope-selector.js");
  const chatController = read("renderer/chat-controller.js");
  const preload = read("electron/preload.js");
  const main = read("electron/main.js");

  assert.match(html, /id="chat-scope-select"/);
  assert.match(html, /Všechny uložené zprávy/);
  assert.match(selector, /source_type/);
  assert.match(selector, /conversation_id/);
  assert.match(selector, /\.scope-picker"\)\.addEventListener\("click"/);
  assert.match(selector, /chatScopeSelect\.showPicker\?\.\(\)/);
  assert.match(chatController, /getSelectedScope\(\)/);
  assert.match(chatController, /question, requestHistory, scope, chatSelection/);
  assert.match(preload, /getChatScopes/);
  assert.match(main, /\/chat\/scopes/);
});

test("changing scope starts a fresh conversation history", () => {
  const selector = read("renderer/chat-scope-selector.js");
  const chatController = read("renderer/chat-controller.js");
  const bindings = read("renderer/event-bindings.js");

  assert.match(selector, /addEventListener\("change"/);
  assert.match(bindings, /chatScopeSelector\.bind\(window\.chatController\.resetConversation\)/);
  assert.match(chatController, /conversationHistory\.length = 0/);
});

test("startup loads lightweight status and database navigation paints before waiting", () => {
  const app = read("renderer/app.js");
  const bindings = read("renderer/event-bindings.js");

  assert.match(app, /overviewController\.refreshStatus\(true\)/);
  assert.doesNotMatch(app, /overviewController\.refresh\(\)/);
  assert.ok(
    bindings.indexOf('showScreen("overview")') < bindings.indexOf("overviewController.open()"),
  );
  assert.ok(
    bindings.indexOf("overviewController.open()") < bindings.indexOf("closeDiscordView(false)"),
  );
});

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
