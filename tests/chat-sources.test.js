const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("chat renders grounded source cards and Discord deep links", () => {
  const sourceRenderer = fs.readFileSync(
    path.join(projectRoot, "renderer", "chat-sources.js"), "utf8",
  );
  const chatController = fs.readFileSync(
    path.join(projectRoot, "renderer", "chat-controller.js"), "utf8",
  );

  assert.match(chatController, /response\.sources/);
  assert.match(sourceRenderer, /Použité zdroje/);
  assert.match(sourceRenderer, /openDiscordSource/);
  assert.match(sourceRenderer, /source_message_ids/);
  assert.match(sourceRenderer, /\.textContent\s*=/);
  assert.doesNotMatch(sourceRenderer, /innerHTML\s*=/);
});
