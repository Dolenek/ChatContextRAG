const { readBody, readJson, sendJson } = require("./http-utils");
const { SettingsRouter } = require("./settings-router");
const { MigrationRouter } = require("./migration-router");

class ApiRouter {
  constructor(options) {
    this.backend = options.backend;
    this.discord = options.discord;
    this.events = options.events;
    this.monitor = options.monitor;
    this.settings = new SettingsRouter(options.settings);
    this.migrations = new MigrationRouter(options.backend, options.monitor);
  }

  async handle(request, response, url, identity) {
    const pathname = url.pathname;
    if (request.method === "GET" && pathname === "/api/runtime") {
      return this.json(response, runtimeCapabilities());
    }
    if (request.method === "GET" && pathname === "/api/events") {
      this.events.connect(request, response);
      return true;
    }
    if (pathname.startsWith("/api/settings")) {
      return this.settings.handle(request, response, pathname);
    }
    if (pathname.startsWith("/api/migrations")) {
      return this.migrations.handle(request, response, pathname, identity);
    }
    if (pathname.startsWith("/api/discord-bot")) {
      return this.handleDiscord(request, response, pathname);
    }
    if (pathname.startsWith("/api/imports/whatsapp")) {
      return this.handleWhatsApp(request, response, pathname);
    }
    if (request.method === "GET" && pathname === "/api/whatsapp/conversations") {
      return this.proxy(response, this.backend.get(
        "/ingestion/conversations?source_type=whatsapp",
      ));
    }
    return this.handleBackendFacade(request, response, url);
  }

  async handleDiscord(request, response, pathname) {
    if (request.method === "GET" && pathname === "/api/discord-bot/status") {
      return this.json(response, this.discord.status());
    }
    if (request.method === "POST" && pathname === "/api/discord-bot/connect") {
      const input = await readJson(request);
      return this.proxy(response, this.discord.connect(input.token));
    }
    if (request.method === "POST" && pathname === "/api/discord-bot/disconnect") {
      return this.proxy(response, this.discord.disconnect());
    }
    if (request.method === "GET" && pathname === "/api/discord-bot/invite") {
      return this.json(response, this.discord.invite());
    }
    return false;
  }

  async handleWhatsApp(request, response, pathname) {
    if (request.method !== "POST") return false;
    const allowed = new Set(["/api/imports/whatsapp/preview", "/api/imports/whatsapp"]);
    if (!allowed.has(pathname)) return false;
    const payload = await readBody(request, 101 * 1024 * 1024);
    const backendPath = pathname.slice("/api".length);
    return this.proxy(response, this.backend.raw("POST", backendPath, payload, {
      "Content-Type": request.headers["content-type"] || "application/octet-stream",
    }));
  }

  async handleBackendFacade(request, response, url) {
    const route = matchBackendRoute(request.method, url.pathname);
    if (!route) return false;
    const path = `${route}${url.search}`;
    const body = ["POST", "PUT", "PATCH", "DELETE"].includes(request.method)
      ? await readJson(request) : undefined;
    const result = await this.backend.request(request.method, path, body);
    this.monitorResult(request.method, route, result);
    return this.json(response, result);
  }

  monitorResult(method, path, result) {
    if (method === "POST" && path.endsWith("/finish")) {
      this.monitor.startSessionJobs(result);
      return;
    }
    if (method !== "POST") return;
    if (result.job_id) this.monitor.start(result.job_id);
    if (result.active_job_id) this.monitor.start(result.active_job_id);
  }

  async proxy(response, promise) {
    return this.json(response, await promise);
  }

  json(response, body) {
    sendJson(response, 200, body);
    return true;
  }
}

function matchBackendRoute(method, pathname) {
  const exact = new Map([
    ["GET /api/chat/scopes", "/chat/scopes"],
    ["GET /api/chat/sessions", "/chat/sessions"],
    ["POST /api/chat", "/chat"],
    ["GET /api/database/overview", "/database/overview"],
    ["GET /api/database/resume-point", "/database/resume-point"],
    ["DELETE /api/database", "/database"],
    ["POST /api/indexing/jobs/pending", "/indexing/jobs/pending"],
    ["POST /api/ingestion/sessions", "/ingestion/sessions"],
    ["POST /api/messages/import", "/messages/import"],
  ]);
  const direct = exact.get(`${method} ${pathname}`);
  if (direct) return direct;
  return matchParameterizedRoute(method, pathname);
}

function matchParameterizedRoute(method, pathname) {
  const chatSession = pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (chatSession && ["GET", "PATCH", "DELETE"].includes(method)) {
    return `/chat/sessions/${encodeURIComponent(decodeURIComponent(chatSession[1]))}`;
  }
  const job = pathname.match(/^\/api\/indexing\/jobs\/([^/]+)(?:\/(retry|cancel))?$/);
  if (job && ((method === "GET" && !job[2]) || (method === "POST" && job[2]))) {
    return `/indexing/jobs/${encodeURIComponent(decodeURIComponent(job[1]))}${job[2] ? `/${job[2]}` : ""}`;
  }
  const finish = pathname.match(/^\/api\/ingestion\/sessions\/([^/]+)\/finish$/);
  if (finish && method === "POST") {
    return `/ingestion/sessions/${encodeURIComponent(decodeURIComponent(finish[1]))}/finish`;
  }
  return null;
}

function runtimeCapabilities() {
  return {
    mode: "web", embeddedDiscord: false, discordBot: true, fileUpload: true,
    migrationExport: false, migrationImport: true, migrationProtocolVersion: 1,
  };
}

module.exports = { ApiRouter, matchBackendRoute, runtimeCapabilities };
