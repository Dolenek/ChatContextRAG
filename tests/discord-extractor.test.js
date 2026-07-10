const test = require("node:test");
const assert = require("node:assert/strict");

const { buildDiscordExtractionScript } = require("../electron/discord-extractor");

test("extraction script targets Discord message identifiers and limits output", () => {
  const script = buildDiscordExtractionScript();
  assert.match(script, /chat-messages-/);
  assert.match(script, /slice\(-4\)/);
  assert.match(script, /message-username-/);
  assert.match(script, /embedFull/);
});
