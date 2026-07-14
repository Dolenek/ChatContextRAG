const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const { ApiRouter, matchBackendRoute, runtimeCapabilities } = require("../web/api-router");
const { loadWebConfig } = require("../web/config");
const { DiscordService } = require("../web/discord-service");
const { EventHub } = require("../web/event-hub");
const { readBody, readJson, sendJson, sendRedirect, sendStatic } = require("../web/http-utils");
const { IndexingMonitor } = require("../web/indexing-monitor");
const { SettingsRouter } = require("../web/settings-router");
const { MigrationRouter, mergeDiscordState } = require("../web/migration-router");

test("web configuration validates required secrets, ports, and session duration", () => {
  assert.throws(() => loadWebConfig({}), /adminPasswordHash.*serverKey/);
  assert.throws(() => loadWebConfig(requiredEnvironment({ WEB_PORT: "70000" })), /WEB_PORT/);
  assert.throws(
    () => loadWebConfig(requiredEnvironment({ WEB_SESSION_HOURS: "0" })),
    /must be positive/,
  );

  const config = loadWebConfig(requiredEnvironment({
    WEB_PORT: "9090", WEB_SESSION_HOURS: "6.5", WEB_TRUST_PROXY: "1",
  }));
  assert.equal(config.port, 9090);
  assert.equal(config.sessionHours, 6.5);
  assert.equal(config.adminUsername, "admin");
  assert.equal(config.trustProxy, true);
});

test("HTTP utilities parse JSON and reject malformed or oversized bodies", async () => {
  assert.deepEqual(await readJson(requestFrom('{"value":3}')), { value: 3 });
  assert.deepEqual(await readJson(requestFrom("")), {});
  await assert.rejects(readJson(requestFrom("{")), (error) => error.statusCode === 400);
  await assert.rejects(readBody(requestFrom("12345"), 4), (error) => error.statusCode === 413);
});

test("HTTP response helpers apply security headers and safe static paths", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "chat-context-static-"));
  fs.writeFileSync(path.join(directory, "page.html"), "<h1>safe</h1>");
  const staticResponse = fakeResponse();
  const traversalResponse = fakeResponse();

  assert.equal(sendStatic(staticResponse, directory, "/page.html"), true);
  assert.equal(sendStatic(traversalResponse, directory, "/../secret.txt"), false);
  assert.equal(staticResponse.statusCode, 200);
  assert.match(staticResponse.headers["Content-Type"], /text\/html/);
  assert.equal(staticResponse.headers["X-Frame-Options"], "DENY");

  const jsonResponse = fakeResponse();
  sendJson(jsonResponse, 201, { created: true });
  assert.equal(jsonResponse.statusCode, 201);
  assert.equal(jsonResponse.body, '{"created":true}');
  const redirectResponse = fakeResponse();
  sendRedirect(redirectResponse, "/login");
  assert.equal(redirectResponse.headers.Location, "/login");
  fs.rmSync(directory, { recursive: true, force: true });
});

test("event hub connects, publishes, removes closed clients, and shuts down", () => {
  const hub = new EventHub();
  const request = eventRequest();
  const response = fakeResponse();

  hub.connect(request, response);
  hub.publish("indexing", { status: "running" });
  assert.match(response.writes.join(""), /connected/);
  assert.match(response.writes.join(""), /"type":"indexing"/);
  request.close();
  assert.equal(hub.clients.size, 0);
  hub.connect(eventRequest(), response);
  hub.close();
  assert.equal(response.ended, true);
  assert.equal(hub.clients.size, 0);
});

test("indexing monitor publishes progress, terminal states, and failures", async (t) => {
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (callback, milliseconds) => {
    delays.push(milliseconds); queueMicrotask(callback); return 0;
  };
  t.after(() => { global.setTimeout = originalSetTimeout; });
  const published = [];
  const states = [{ status: "running" }, { status: "completed" }];
  const monitor = new IndexingMonitor({
    get: async () => states.shift(),
  }, { publish: (...arguments) => published.push(arguments) });

  monitor.activeJobs.add("job-1");
  await monitor.poll("job-1");
  assert.deepEqual(published.map((item) => item[0]), ["indexing", "indexing"]);
  assert.deepEqual(delays, [1000, 2500]);
  assert.equal(monitor.activeJobs.has("job-1"), false);

  const failing = new IndexingMonitor({
    get: async () => { throw new Error("offline"); },
  }, { publish: (...arguments) => published.push(arguments) });
  await failing.poll("job-2");
  assert.deepEqual(published.at(-1), [
    "indexing-error", { job_id: "job-2", detail: "offline" },
  ]);
});

test("settings router decodes identifiers and forwards JSON lifecycle requests", async () => {
  const calls = [];
  const coordinator = new Proxy({}, {
    get: (_target, name) => (...arguments) => {
      calls.push([name, ...arguments]);
      return { operation: name };
    },
  });
  const router = new SettingsRouter(coordinator);
  const response = fakeResponse();

  assert.equal(await router.handle(requestFrom("", "GET"), response, "/api/settings"), true);
  assert.equal(await router.handle(
    requestFrom('{"auto_sync":false}', "PATCH"), response,
    "/api/settings/embedding-indexes/index%20one",
  ), true);
  assert.equal(await router.handle(
    requestFrom("", "DELETE"), response, "/api/settings/providers/local%20api",
  ), true);
  assert.equal(await router.handle(requestFrom("", "GET"), response, "/api/not-settings"), false);

  assert.deepEqual(calls[0], ["getSettings"]);
  assert.deepEqual(calls[1], ["updateIndex", "index one", { auto_sync: false }]);
  assert.deepEqual(calls[2], ["deleteProvider", "local api"]);
});

test("API route allowlist normalizes identifiers and rejects unsupported methods", () => {
  assert.equal(matchBackendRoute("GET", "/api/chat/scopes"), "/chat/scopes");
  assert.equal(matchBackendRoute("GET", "/api/chat/sessions"), "/chat/sessions");
  assert.equal(
    matchBackendRoute("PATCH", "/api/chat/sessions/chat%20one"),
    "/chat/sessions/chat%20one",
  );
  assert.equal(
    matchBackendRoute("DELETE", "/api/chat/sessions/chat%20one"),
    "/chat/sessions/chat%20one",
  );
  assert.equal(
    matchBackendRoute("POST", "/api/indexing/jobs/job%20one/retry"),
    "/indexing/jobs/job%20one/retry",
  );
  assert.equal(matchBackendRoute("DELETE", "/api/chat"), null);
  assert.equal(matchBackendRoute("GET", "/api/internal/provider-registry"), null);
  assert.deepEqual(runtimeCapabilities(), {
    mode: "web", embeddedDiscord: false, discordBot: true, fileUpload: true,
    migrationExport: false, migrationImport: true, migrationProtocolVersion: 1,
  });
});

test("API router proxies facade calls and starts returned indexing jobs", async () => {
  const monitored = [];
  const backend = {
    request: async (...arguments) => ({ arguments, job_id: "job-1" }),
  };
  const router = new ApiRouter({
    backend, discord: {}, events: {}, settings: {},
    monitor: { start: (id) => monitored.push(id), startSessionJobs: () => {} },
  });
  const response = fakeResponse();

  const handled = await router.handle(
    requestFrom('{"question":"hello"}', "POST"), response,
    new URL("http://server/api/chat?language=cs"),
  );

  assert.equal(handled, true);
  assert.deepEqual(monitored, ["job-1"]);
  assert.match(response.body, /\/chat\?language=cs/);
});

test("migration router requires bearer auth and safely merges Discord state", async () => {
  const calls = [];
  const backend = {
    get: async (pathname) => {
      calls.push(["get", pathname]);
      return pathname.startsWith("/integrations") ? [{
        source_type: "discord", conversation_id: "20", oldest_cursor: "200",
        newest_cursor: "500", tracking_enabled: false, backfill_complete: false,
      }] : { status: "running", raw_message_count: 0 };
    },
    post: async (pathname, body) => { calls.push(["post", pathname, body]); return body; },
  };
  const router = new MigrationRouter(backend, { startSessionJobs: () => {} });
  const url = "/api/migrations/migration-1/sync-states";

  await assert.rejects(
    router.handle(requestFrom('{"states":[]}', "PUT"), fakeResponse(), url, { kind: "session" }),
    (error) => error.statusCode === 403,
  );
  const response = fakeResponse();
  await router.handle(requestFrom(JSON.stringify({ states: [{
    source_type: "discord", conversation_id: "20", oldest_cursor: "100",
    newest_cursor: "450", tracking_enabled: true, backfill_complete: true,
  }] }), "PUT"), response, url, { kind: "bearer" });

  const saved = calls.find((call) => call[0] === "post")[2];
  assert.equal(saved.oldest_cursor, "100");
  assert.equal(saved.newest_cursor, "500");
  assert.equal(saved.tracking_enabled, false);
  assert.equal(saved.backfill_complete, true);
  assert.equal(saved.active_session_id, null);
});

test("migration state merge keeps destination labels and handles cursor boundaries", () => {
  const merged = mergeDiscordState(
    { conversation_id: "20", conversation_label: "Server", tracking_enabled: true },
    { source_type: "discord", conversation_id: "20", conversation_label: "Local" },
  );

  assert.equal(merged.conversation_label, "Server");
  assert.equal(merged.tracking_enabled, true);
  assert.equal(merged.last_error, null);
});

test("migration completion is idempotent after a lost gateway response", async () => {
  let status = "running";
  let finishCalls = 0;
  const backend = {
    get: async () => ({ status, raw_message_count: 400 }),
    post: async () => {
      finishCalls += 1;
      status = "completed";
      return { status, raw_message_count: 400 };
    },
  };
  const router = new MigrationRouter(backend, { startSessionJobs: () => {} });

  const first = await router.complete("migration-1");
  const repeated = await router.complete("migration-1");

  assert.equal(first.status, "completed");
  assert.equal(repeated.status, "completed");
  assert.equal(finishCalls, 1);
});

test("Discord web service chunks imports and monitors finished sessions", async () => {
  const calls = [];
  const monitored = [];
  const backend = {
    post: async (pathname, body) => {
      calls.push([pathname, body]);
      return pathname.endsWith("/finish")
        ? { indexing_job_ids: ["job-1", "job-2"] } : { imported_count: body.messages.length };
    },
    get: async () => [],
  };
  const service = new DiscordService({
    backend, events: { publish: () => {} },
    monitor: { startSessionJobs: (session) => monitored.push(session) },
    tokenStore: { load: () => null, clear: () => {} },
  });
  const messages = Array.from({ length: 401 }, (_, index) => ({ external_id: String(index) }));

  const latest = await service.importBatches("session-1", messages);
  const finished = await service.finishSession("session-1", "completed");

  assert.deepEqual(calls.slice(0, 2).map((call) => call[1].messages.length), [400, 1]);
  assert.equal(latest.imported_count, 1);
  assert.deepEqual(monitored, [finished]);
});

function requiredEnvironment(overrides = {}) {
  return {
    WEB_ADMIN_PASSWORD_HASH: "hash", CHAT_CONTEXT_SERVER_KEY: "key",
    CHAT_CONTEXT_DESKTOP_TOKEN: "desktop", CHAT_CONTEXT_INTERNAL_TOKEN: "internal",
    ...overrides,
  };
}

function requestFrom(body, method = "POST") {
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = method;
  request.headers = {};
  return request;
}

function fakeResponse() {
  return {
    writes: [], ended: false, body: "",
    writeHead(statusCode, headers) { this.statusCode = statusCode; this.headers = headers; },
    write(chunk) { this.writes.push(String(chunk)); },
    end(body = "") { this.body = Buffer.isBuffer(body) ? body.toString() : String(body); this.ended = true; },
  };
}

function eventRequest() {
  return {
    on(name, callback) { if (name === "close") this.close = callback; },
  };
}
