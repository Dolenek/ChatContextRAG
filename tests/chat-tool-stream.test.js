const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");

const { ChatIpcController } = require("../electron/chat-ipc");
const { BackendClient } = require("../runtime/backend-client");
const { ApiRouter } = require("../web/api-router");

const root = path.resolve(__dirname, "..");

test("backend client parses NDJSON records split across network chunks", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  const encoder = new TextEncoder();
  global.fetch = async () => ({
    ok: true,
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"type":"tool_started","activity":'));
        controller.enqueue(encoder.encode('{"sequence":1}}\n{"type":"final","response":{"answer":"ok"}}\n'));
        controller.close();
      },
    }),
  });
  const records = [];

  await new BackendClient("https://archive.example").streamNdjson(
    "/chat/stream", { question: "when" }, (record) => records.push(record),
  );

  assert.deepEqual(records.map((record) => record.type), ["tool_started", "final"]);
  assert.equal(records[0].activity.sequence, 1);
});

test("Electron stream correlates progress and returns only its final response", async () => {
  const handlers = new Map();
  const sent = [];
  const ipcMain = { handle: (name, callback) => handlers.set(name, callback) };
  const backend = {
    streamNdjson: async (_path, _body, publish, options) => {
      assert.equal(options.timeoutMs, 130_000);
      publish({ type: "tool_started", activity: { sequence: 1 } });
      publish({ type: "final", response: { answer: "grounded" } });
    },
  };
  new ChatIpcController(ipcMain, () => backend).register();
  const event = {
    sender: {
      isDestroyed: () => false,
      send: (channel, payload) => sent.push([channel, payload]),
    },
  };

  const response = await handlers.get("database:ask-stream")(event, {
    requestId: "request-7", request: { question: "when" },
  });

  assert.equal(response.answer, "grounded");
  assert.deepEqual(sent, [["database:chat-progress", {
    requestId: "request-7",
    record: { type: "tool_started", activity: { sequence: 1 } },
  }]]);
});

test("web gateway writes each upstream chat record without buffering", async () => {
  const backend = {
    streamNdjson: async (_path, body, publish) => {
      assert.equal(body.question, "when");
      publish({ type: "tool_started", activity: { sequence: 1 } });
      publish({ type: "final", response: { answer: "grounded" } });
    },
  };
  const router = new ApiRouter({
    backend, discord: {}, events: {}, settings: {},
    monitor: { start: () => {}, startSessionJobs: () => {} },
  });
  const request = Readable.from([Buffer.from('{"question":"when"}')]);
  request.method = "POST";
  const response = streamingResponse();

  const handled = await router.handle(
    request, response, new URL("https://archive.example/api/chat/stream"), {},
  );

  assert.equal(handled, true);
  assert.match(response.headers["Content-Type"], /application\/x-ndjson/);
  assert.equal(response.writes.length, 2);
  assert.equal(JSON.parse(response.writes[0]).type, "tool_started");
  assert.equal(response.ended, true);
});

test("web gateway reports an upstream timeout after opening the stream", async () => {
  const backend = {
    streamNdjson: async () => {
      throw Object.assign(new Error("late"), { code: "BACKEND_TIMEOUT" });
    },
  };
  const router = streamRouter(backend);
  const request = Readable.from([Buffer.from('{"question":"when"}')]);
  request.method = "POST";
  const response = streamingResponse();

  await router.handle(
    request, response, new URL("https://archive.example/api/chat/stream"), {},
  );

  assert.equal(JSON.parse(response.writes[0]).code, "timeout");
  assert.equal(response.ended, true);
});

test("web gateway aborts its upstream read when the client disconnects", async () => {
  let upstreamAborted = false;
  const backend = {
    streamNdjson: async (_path, _body, _publish, options) => {
      await new Promise((resolve) => options.signal.addEventListener("abort", resolve));
      upstreamAborted = true;
    },
  };
  const router = streamRouter(backend);
  const request = Readable.from([Buffer.from('{"question":"when"}')]);
  request.method = "POST";
  const response = streamingResponse();
  setTimeout(() => {
    response.destroyed = true;
    response.emit("close");
  }, 0);

  await router.handle(
    request, response, new URL("https://archive.example/api/chat/stream"), {},
  );

  assert.equal(upstreamAborted, true);
  assert.equal(response.writes.length, 0);
});

test("tool timeline is persisted, collapsible, and rendered with textContent", () => {
  const view = read("renderer/tool-activity-view.js");
  const conversation = read("renderer/conversation-view.js");
  const controller = read("renderer/chat-controller.js");

  assert.match(view, /document\.createElement\("details"\)/);
  assert.match(view, /Archivní kroky \(\$\{activities\.length\}\)/);
  assert.match(view, /row\.textContent = describe\(activity\)/);
  assert.doesNotMatch(view, /innerHTML/);
  assert.match(conversation, /message\.tool_activity \|\| \[\]/);
  assert.match(controller, /response\.tool_activity \|\| \[\]/);
});

test("workspace timezone uses a searchable IANA list and shared bridges", () => {
  const timezoneUi = read("renderer/workspace-timezone-ui.js");
  const coordinator = read("runtime/settings-coordinator.js");
  const preload = read("electron/preload.js");
  const webBridge = read("renderer/runtime-bridge.js");

  assert.match(timezoneUi, /document\.createElement\("datalist"\)/);
  assert.match(timezoneUi, /Intl\.supportedValuesOf\?\.\("timeZone"\)/);
  assert.match(coordinator, /backend\.put\("\/settings\/workspace"/);
  assert.match(preload, /updateWorkspaceSettings:/);
  assert.match(webBridge, /updateWorkspaceSettings:/);
});

function streamingResponse() {
  const response = new EventEmitter();
  response.writes = [];
  response.destroyed = false;
  response.writableEnded = false;
  response.writeHead = (_status, headers) => { response.headers = headers; };
  response.flushHeaders = () => {};
  response.write = (chunk) => { response.writes.push(chunk); return true; };
  response.end = () => {
    response.ended = true;
    response.writableEnded = true;
  };
  return response;
}

function streamRouter(backend) {
  return new ApiRouter({
    backend, discord: {}, events: {}, settings: {},
    monitor: { start: () => {}, startSessionJobs: () => {} },
  });
}

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}
