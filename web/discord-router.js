const { readJson, sendJson } = require("./http-utils");

class DiscordRouter {
  constructor(discordService) {
    this.discord = discordService;
  }

  async handle(request, response, url) {
    const pathname = url.pathname;
    if (pathname === "/api/discord-bot/status" && request.method === "GET") {
      return this.json(response, this.discord.status());
    }
    if (pathname === "/api/discord-bot/connect" && request.method === "POST") {
      const input = await readJson(request);
      return this.resolve(response, this.discord.connect(input.token));
    }
    if (pathname === "/api/discord-bot/pause" && request.method === "POST") {
      return this.resolve(response, this.discord.pause());
    }
    if (pathname === "/api/discord-bot/resume" && request.method === "POST") {
      return this.resolve(response, this.discord.resume());
    }
    if (pathname === "/api/discord-bot/disconnect" && request.method === "POST") {
      return this.resolve(response, this.discord.disconnect());
    }
    if (pathname === "/api/discord-bot/invite" && request.method === "GET") {
      return this.json(response, this.discord.invite());
    }
    return this.handleSettingsOrHistory(request, response, url);
  }

  async handleSettingsOrHistory(request, response, url) {
    const route = this.matchRoute(request.method, url.pathname);
    if (!route) return false;
    if (route.name === "settings") return this.resolve(response, this.discord.settings());
    if (route.name === "model") {
      return this.resolve(response, this.discord.updateModel(await readJson(request)));
    }
    if (route.name === "permissions") {
      return this.resolve(response, this.discord.updatePermissions(await readJson(request)));
    }
    if (route.name === "roles") return this.resolve(response, this.discord.roles(route.guildId));
    if (route.name === "members") {
      return this.resolve(response, this.discord.members(route.guildId, url.searchParams.get("query")));
    }
    if (route.name === "availability") {
      const input = await readJson(request);
      return this.resolve(
        response, this.discord.subjectAvailability(route.guildId, input.subjects || []),
      );
    }
    return this.handleHistory(request, response, url, route);
  }

  handleHistory(request, response, url, route) {
    if (route.name === "history") {
      if (request.method === "DELETE") {
        return this.resolve(response, this.discord.deleteAnswers(url.searchParams.get("guild_id")));
      }
      return this.resolve(response, this.discord.listAnswers({
        limit: url.searchParams.get("limit"), offset: url.searchParams.get("offset"),
        guildId: url.searchParams.get("guild_id"),
        channelId: url.searchParams.get("channel_id"),
      }));
    }
    if (request.method === "DELETE") {
      return this.resolve(response, this.discord.deleteAnswer(route.answerId));
    }
    return this.resolve(response, this.discord.answerDetail(route.answerId));
  }

  matchRoute(method, pathname) {
    const exact = new Map([
      ["GET /api/discord-bot/settings", { name: "settings" }],
      ["PUT /api/discord-bot/settings/model", { name: "model" }],
      ["GET /api/discord-bot/answers", { name: "history" }],
      ["DELETE /api/discord-bot/answers", { name: "history" }],
    ]).get(`${method} ${pathname}`);
    if (exact) return exact;
    return matchGuildRoute(method, pathname) || matchAnswerRoute(method, pathname);
  }

  async resolve(response, promise) {
    return this.json(response, await promise);
  }

  json(response, body) {
    sendJson(response, 200, body);
    return true;
  }
}

function matchGuildRoute(method, pathname) {
  const availability = pathname.match(
    /^\/api\/discord-bot\/guilds\/([^/]+)\/subjects\/availability$/,
  );
  if (availability) return method === "POST"
    ? { name: "availability", guildId: decodeURIComponent(availability[1]) } : null;
  const match = pathname.match(/^\/api\/discord-bot\/guilds\/([^/]+)\/(permissions|roles|members)$/);
  if (!match) return null;
  const action = match[2];
  const expectedMethod = action === "permissions" ? "PUT" : "GET";
  if (method !== expectedMethod) return null;
  return { name: action, guildId: decodeURIComponent(match[1]) };
}

function matchAnswerRoute(method, pathname) {
  const match = pathname.match(/^\/api\/discord-bot\/answers\/([^/]+)$/);
  if (!match || !["GET", "DELETE"].includes(method)) return null;
  return { name: "answer", answerId: decodeURIComponent(match[1]) };
}

module.exports = { DiscordRouter, matchAnswerRoute, matchGuildRoute };
