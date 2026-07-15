const http = require("node:http");
const path = require("node:path");

const { ProviderStore } = require("../electron/provider-store");
const { BackendClient } = require("../runtime/backend-client");
const { SecretStore } = require("../runtime/secret-store");
const { SettingsCoordinator } = require("../runtime/settings-coordinator");
const { ToggleableSecretStore } = require("../runtime/toggleable-secret-store");
const { AesGcmStorage } = require("./aes-storage");
const { ApiRouter } = require("./api-router");
const { AuthService, sameOrigin } = require("./auth");
const { DiscordService } = require("./discord-service");
const { EventHub } = require("./event-hub");
const { httpError, readJson, sendJson, sendRedirect, sendStatic } = require("./http-utils");
const { IndexingMonitor } = require("./indexing-monitor");
const { loadWebConfig } = require("./config");

class WebApplication {
  constructor(config, overrides = {}) {
    this.config = config;
    this.auth = overrides.auth || new AuthService(config);
    this.events = overrides.events || new EventHub();
    this.backend = overrides.backend || new BackendClient(config.apiUrl, {
      "X-Chat-Context-Token": config.internalToken,
    });
    const services = overrides.services || createServices(config, this.backend, this.events);
    this.discord = services.discord;
    this.settings = services.settings;
    this.monitor = services.monitor;
    this.api = new ApiRouter({ ...services, backend: this.backend, events: this.events });
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async start() {
    await waitForBackend(this.backend);
    await this.settings.initializeRegistry();
    await this.discord.restore();
    await new Promise((resolve) => {
      this.server.listen(this.config.port, this.config.bindAddress, resolve);
    });
    return this.server.address();
  }

  async stop() {
    await this.discord.shutdown();
    this.events.close();
    if (this.server.listening) {
      await new Promise((resolve) => this.server.close(resolve));
    }
  }

  async handle(request, response) {
    let url;
    try {
      url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      if (await this.handlePublic(request, response, url)) return;
      const identity = this.auth.authenticate(request);
      if (isMutation(request)) this.auth.authorizeMutation(request, identity);
      if (await this.handleAuthenticated(request, response, url, identity)) return;
      sendJson(response, 404, { detail: "Not found." });
    } catch (error) {
      if (error.statusCode === 401 && request.method === "GET"
        && url && !url.pathname.startsWith("/api/")) {
        sendRedirect(response, "/login");
        return;
      }
      const unexpectedError = !Number.isInteger(error.statusCode);
      const statusCode = unexpectedError ? 500 : error.statusCode;
      if (unexpectedError) console.error("Web request failed", error);
      const detail = unexpectedError ? "Internal server error." : error.message;
      const headers = error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {};
      sendJson(response, statusCode, { detail }, headers);
    }
  }

  async handlePublic(request, response, url) {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return this.handleHealth(response);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      return this.handleLogin(request, response);
    }
    if (request.method === "GET" && url.pathname === "/login") {
      return sendStatic(response, __dirname, "/login.html");
    }
    if (request.method === "GET" && ["/login.js", "/login.css"].includes(url.pathname)) {
      return sendStatic(response, __dirname, url.pathname);
    }
    if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
      const assetRoot = path.join(this.config.projectRoot, "renderer", "assets");
      return sendStatic(response, assetRoot, url.pathname.slice("/assets".length));
    }
    return false;
  }

  async handleAuthenticated(request, response, url, identity) {
    if (request.method === "GET" && url.pathname === "/api/auth/session") {
      return this.handleSession(response, identity);
    }
    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      return this.handleLogout(request, response);
    }
    if (url.pathname.startsWith("/api/")) {
      return this.api.handle(request, response, url, identity);
    }
    if (request.method !== "GET") return false;
    return this.serveRenderer(response, url.pathname);
  }

  async handleHealth(response) {
    try {
      await this.backend.get("/internal/health");
      sendJson(response, 200, { status: "ok" });
    } catch {
      sendJson(response, 503, { status: "unavailable" });
    }
    return true;
  }

  async handleLogin(request, response) {
    if (!sameOrigin(request, this.config.trustProxy)) throw httpError("Invalid origin.", 403);
    const input = await readJson(request, 16 * 1024);
    const session = await this.auth.login(
      input.username, input.password, this.auth.clientAddress(request),
    );
    sendJson(response, 200, { authenticated: true }, {
      "Set-Cookie": this.auth.sessionCookie(session, request),
    });
    return true;
  }

  handleSession(response, identity) {
    sendJson(response, 200, {
      authenticated: true,
      csrf_token: identity.kind === "session" ? identity.session.csrfToken : null,
      capabilities: {
        mode: "web", embeddedDiscord: false, discordBot: true, fileUpload: true,
        migrationExport: false, migrationImport: true, migrationProtocolVersion: 1,
      },
    });
    return true;
  }

  handleLogout(request, response) {
    this.auth.logout(request);
    sendJson(response, 200, { authenticated: false }, {
      "Set-Cookie": this.auth.clearCookie(request),
    });
    return true;
  }

  serveRenderer(response, pathname) {
    const rendererRoot = path.join(this.config.projectRoot, "renderer");
    const requestedFile = pathname === "/" ? "/index.html" : pathname;
    return sendStatic(response, rendererRoot, requestedFile);
  }
}

function createServices(config, backend, events) {
  const encryption = new AesGcmStorage(config.serverKey);
  const providerStore = new ProviderStore(config.stateDirectory, encryption);
  const monitor = new IndexingMonitor(backend, events);
  const settings = new SettingsCoordinator({
    providerStore, backend, internalToken: config.internalToken,
    monitorJob: (jobId) => monitor.start(jobId),
  });
  const tokenStore = new ToggleableSecretStore(
    new SecretStore(path.join(config.stateDirectory, "discord-bot-token.enc"), encryption),
    path.join(config.stateDirectory, "discord-bot-state.json"),
  );
  const discord = new DiscordService({ backend, events, monitor, tokenStore });
  return { discord, monitor, settings };
}

async function waitForBackend(backend) {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await backend.get("/internal/health");
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`FastAPI did not become ready: ${lastError?.message || "unknown error"}`);
}

function isMutation(request) {
  return !["GET", "HEAD", "OPTIONS"].includes(request.method);
}

async function run() {
  const application = new WebApplication(loadWebConfig());
  await application.start();
  console.log(`Chat Context web is listening on ${application.config.bindAddress}:${application.config.port}`);
  const shutdown = async () => {
    await application.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { WebApplication, createServices, waitForBackend };
