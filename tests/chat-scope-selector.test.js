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
  assert.match(chatController, /getSelectedScope\(\)/);
  assert.match(chatController, /askDatabase\(question, requestHistory, scope\)/);
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

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
