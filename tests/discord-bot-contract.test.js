const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { IntegrationIpcController, historyQuery } = require("../electron/integration-ipc");
const { DiscordRouter, matchAnswerRoute, matchGuildRoute } = require("../web/discord-router");
const { historyQuery: webHistoryQuery } = require("../web/discord-service");

const root = path.resolve(__dirname, "..");

test("Discord settings and history paths are shared by local and web transports", () => {
  const local = Object.create(IntegrationIpcController.prototype);
  const calls = [];
  local.getJson = async (url) => calls.push(["GET", url]);
  local.putJson = async (url, body) => calls.push(["PUT", url, body]);
  local.postJson = async (url, body, options) => calls.push(["POST", url, body, options]);
  local.patchJson = async (url, body) => calls.push(["PATCH", url, body]);
  const api = local.botApi();

  api.getDiscordBotSettings();
  api.updateDiscordBotModel({ chat_model: "gpt" });
  api.updateDiscordGuildPermissions({ guild_id: "guild/id" });
  api.answerDiscordQuestion({ question: "hello" });
  api.recordDiscordAnswerDelivery("answer/id", { message_ids: ["1"] });

  assert.deepEqual(calls.map((call) => call.slice(0, 2)), [
    ["GET", "/integrations/discord-bot/settings"],
    ["PUT", "/integrations/discord-bot/settings/model"],
    ["PUT", "/integrations/discord-bot/guilds/guild%2Fid/permissions"],
    ["POST", "/integrations/discord-bot/answers"],
    ["PATCH", "/integrations/discord-bot/answers/answer%2Fid/delivery"],
  ]);
  assert.equal(calls[3][3].timeoutMs, 130_000);
  assert.equal(historyQuery({ limit: 10, guildId: "10", channelId: "20" }),
    webHistoryQuery({ limit: 10, guildId: "10", channelId: "20" }));
});

test("web Discord router validates guild directory and answer history routes", () => {
  const router = new DiscordRouter({});

  assert.deepEqual(router.matchRoute("GET", "/api/discord-bot/settings"), { name: "settings" });
  assert.deepEqual(matchGuildRoute("PUT", "/api/discord-bot/guilds/10/permissions"), {
    name: "permissions", guildId: "10",
  });
  assert.deepEqual(matchGuildRoute("GET", "/api/discord-bot/guilds/a%2Fb/members"), {
    name: "members", guildId: "a/b",
  });
  assert.deepEqual(matchAnswerRoute("DELETE", "/api/discord-bot/answers/answer%2F1"), {
    name: "answer", answerId: "answer/1",
  });
  assert.equal(matchGuildRoute("POST", "/api/discord-bot/guilds/10/roles"), null);
});

test("Electron and browser bridges expose the complete Discord settings contract", () => {
  const preload = read("electron/preload.js");
  const browser = read("renderer/runtime-bridge.js");
  const methods = [
    "getDiscordBotSettings", "updateDiscordBotModel", "updateDiscordGuildPermissions",
    "getDiscordGuildRoles", "searchDiscordGuildMembers", "listDiscordBotAnswers",
    "getDiscordSubjectAvailability", "getDiscordBotAnswer",
    "deleteDiscordBotAnswer", "deleteDiscordBotAnswers",
  ];

  methods.forEach((method) => {
    assert.match(preload, new RegExp(`${method}:`));
    assert.match(browser, new RegExp(`${method}:`));
  });
});

test("Discord settings replaces the source drawer with focused settings modules", () => {
  const html = read("renderer/index.html");
  const settings = read("renderer/discord-bot-settings-ui.js");
  const history = read("renderer/discord-bot-history-ui.js");

  assert.doesNotMatch(html, /id="discord-bot-drawer-panel"/);
  assert.match(html, /data-settings-section="discord-bot"/);
  assert.match(html, /id="discord-bot-settings-root"/);
  assert.match(settings, /Správa synchronizace/);
  assert.match(settings, /Pokládání otázek/);
  assert.match(settings, /Zobrazit historii odpovědí/);
  assert.match(history, /recent_context/);
  assert.match(history, /tool_activity/);
  assert.match(history, /returnFocus\?\.focus/);
});

test("renderer keeps Discord dynamic values out of HTML interpolation", () => {
  const history = read("renderer/discord-bot-history-ui.js");

  assert.match(history, /node\.textContent = content/);
  assert.doesNotMatch(history, /innerHTML\s*=.*detail\./);
  assert.match(history, /confirm\("Smazat tento audit/);
  assert.match(history, /Discord zprávy ani archiv se nesmažou/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
