const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDiscordChannelContextScript, buildDiscordExtractionScript,
  buildDiscordScanObservationScript, buildDiscordScrollUpScript,
} = require("../electron/discord-extractor");

test("extraction script targets Discord message identifiers and limits output", () => {
  const script = buildDiscordExtractionScript();
  assert.match(script, /chat-messages-/);
  assert.match(script, /slice\(-4\)/);
  assert.match(script, /message-username-/);
  assert.match(script, /embedFull/);
  assert.match(script, /channel_id/);
});

test("channel context uses stable Discord route identifiers", () => {
  const script = buildDiscordChannelContextScript();
  assert.match(script, /routeParts\[1\]/);
  assert.match(script, /routeParts\[2\]/);
  assert.match(script, /channelId/);
});

test("scan script discovers the scroll container without Discord class hashes", () => {
  const observation = buildDiscordScanObservationScript();
  const scroll = buildDiscordScrollUpScript();
  assert.match(observation, /scrollHeight/);
  assert.match(observation, /overflowY/);
  assert.match(scroll, /scrollTop/);
  assert.doesNotMatch(observation, /scroller__\w+/);
});
