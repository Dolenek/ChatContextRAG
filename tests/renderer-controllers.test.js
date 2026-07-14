const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force;
    enabled ? this.add(value) : this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.children = [];
    this.classList = new FakeClassList();
    this.listeners = {};
    this.value = "";
    this.disabled = false;
    this.textContent = "";
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  querySelector(selector) {
    return selector === ".empty-chat"
      ? this.children.find((child) => child.className === "empty-chat") || null : null;
  }
  remove() { this.removed = true; }
  focus() { this.focused = true; }
  setAttribute(name, value) { this[name] = value; }
  get className() { return this._className || ""; }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList();
    value.split(/\s+/).filter(Boolean).forEach((item) => this.classList.add(item));
  }
}

test("chat controller sends bounded history and delegates safe message rendering", async () => {
  const questionInput = new FakeElement("input");
  const submitButton = new FakeElement("button");
  const requests = [];
  const shownSources = [];
  const savedSessions = [];
  const renderedUsers = [];
  const renderedAssistants = [];
  const persistedEntries = [];
  const elements = new Map([
    ["#question-input", questionInput],
    ["#chat-form button[type='submit']", submitButton],
    ["#chat-scope-select", { selectedOptions: [{ textContent: "General · 10" }] }],
  ]);
  const context = {
    document: {
      querySelector: (selector) => elements.get(selector),
      createElement: (tagName) => new FakeElement(tagName),
    },
    window: {
      chatContext: {
        askDatabase: async (...arguments) => {
          requests.push(arguments);
          return {
            answer: "grounded", sources: [{ content: "source" }],
            chat_session_id: "session-1", chat_session_title: "First question",
          };
        },
      },
      chatScopeSelector: { getSelectedScope: () => ({ source_type: "discord", conversation_id: "20" }) },
      modelSelector: {
        getChatSelection: () => ({
          providerId: "openai", model: "chat", reasoningEffort: "high",
        }),
        updateAvailability: () => {},
      },
      retrievalModeSelector: {
        getSelection: () => ({
          retrievalMode: "adaptive", evidenceCharacterLimit: 24000,
        }),
      },
      chatHistoryUi: { responseSaved: (response) => savedSessions.push(response.chat_session_id) },
      contextPanel: { showSources: (sources) => shownSources.push(sources), clear: () => {} },
      conversationView: {
        appendUser: (text) => {
          const entry = { text };
          renderedUsers.push(text);
          return entry;
        },
        appendThinking: () => ({ thinking: true }),
        replaceThinking: (_entry, text, sources) => renderedAssistants.push([text, sources]),
        removeThinking: () => {}, markFailed: () => {},
        markPersisted: (entry) => persistedEntries.push(entry.text),
        resetComposer: () => { questionInput.value = ""; },
      },
      shellController: { openContext: () => {}, setDiscordActive: () => {}, showScreen: () => {}, closeDrawer: () => {} },
    },
  };
  vm.runInNewContext(read("renderer/chat-controller.js"), context);

  questionInput.value = "<img src=x onerror=alert(1)>";
  await context.window.chatController.submitQuestion({ preventDefault: () => {} });
  questionInput.value = "second question";
  await context.window.chatController.submitQuestion({ preventDefault: () => {} });

  assert.deepEqual(Array.from(requests[0][1]), []);
  assert.equal(requests[0][4], null);
  assert.equal(requests[0][3].reasoningEffort, "high");
  assert.equal(requests[0][3].retrievalMode, "adaptive");
  assert.equal(requests[0][3].evidenceCharacterLimit, 24000);
  assert.equal(requests[1][4], "session-1");
  assert.deepEqual(JSON.parse(JSON.stringify(requests[1][1])), [
    { role: "user", content: "<img src=x onerror=alert(1)>" },
    { role: "assistant", content: "grounded" },
  ]);
  assert.deepEqual(renderedUsers, ["<img src=x onerror=alert(1)>", "second question"]);
  assert.equal(renderedAssistants[0][0], "grounded");
  assert.deepEqual(persistedEntries, ["<img src=x onerror=alert(1)>", "second question"]);
  assert.equal(shownSources.length, 2);
  assert.deepEqual(savedSessions, ["session-1", "session-1"]);
  assert.equal(submitButton.disabled, false);
  assert.equal(questionInput.focused, true);
});

test("web runtime bridge attaches CSRF, reuses the session, and dispatches events", async () => {
  const fetchCalls = [];
  const opened = [];
  const redirects = [];
  const eventSources = [];
  const responses = [
    response(200, { csrf_token: "csrf" }),
    response(200, { answer: "grounded", sources: [] }),
    response(200, { deleted_chunks: 4 }),
  ];
  class FakeEventSource {
    constructor(url) { this.url = url; eventSources.push(this); }
  }
  const context = {
    Blob, FormData, EventSource: FakeEventSource,
    fetch: async (...arguments) => { fetchCalls.push(arguments); return responses.shift(); },
    document: {
      body: { classList: { add: () => {} } },
      querySelector: () => null,
      createElement: () => new FakeElement("input"),
    },
    window: {
      addEventListener: () => {}, setTimeout: (callback) => callback(),
      location: { replace: (url) => redirects.push(url) },
      open: (...arguments) => opened.push(arguments),
    },
  };
  context.window.window = context.window;
  vm.runInNewContext(read("renderer/runtime-bridge.js"), context);

  await context.window.chatContext.askDatabase(
    "question", [], { source_type: "discord", conversation_id: "20" },
    { providerId: "openai", model: "chat", reasoningEffort: "high" },
    null,
  );
  await context.window.chatContext.clearDatabase("VYMAZAT");
  const indexingEvents = [];
  context.window.chatContext.onIndexingProgress((event) => indexingEvents.push(event));
  eventSources[0].onmessage({
    data: JSON.stringify({ type: "indexing", payload: { status: "running" } }),
  });

  assert.equal(fetchCalls.filter((call) => call[0] === "/api/auth/session").length, 1);
  assert.equal(fetchCalls[1][1].headers["X-CSRF-Token"], "csrf");
  assert.deepEqual(JSON.parse(fetchCalls[1][1].body), {
    question: "question", history: [],
    scope: { source_type: "discord", conversation_id: "20" },
    chat_provider_id: "openai", chat_model: "chat",
    reasoning_effort: "high",
    retrieval_mode: "deterministic",
  });
  assert.equal(fetchCalls[2][1].method, "DELETE");
  assert.deepEqual(JSON.parse(JSON.stringify(indexingEvents)), [{ status: "running" }]);
  assert.equal(eventSources[0].url, "/api/events");
  assert.equal(context.window.chatContext.openDiscordSource, undefined);
  assert.deepEqual(opened, []);
  assert.deepEqual(redirects, []);
});

test("web runtime starts authenticated GET data while the CSRF session is loading", async () => {
  const fetchCalls = [];
  let resolveSession;
  const sessionResponse = new Promise((resolve) => { resolveSession = resolve; });
  const context = {
    FormData,
    EventSource: class {},
    fetch: async (url) => {
      fetchCalls.push(url);
      if (url === "/api/auth/session") return sessionResponse;
      return response(200, { total_chunks: 7 });
    },
    document: {
      body: { classList: { add: () => {} } },
      querySelector: () => null,
    },
    window: { location: { replace: () => {} } },
  };
  context.window.window = context.window;
  vm.runInNewContext(read("renderer/runtime-bridge.js"), context);

  const status = await context.window.chatContext.getDatabaseStatus();

  assert.equal(status.total_chunks, 7);
  assert.deepEqual(fetchCalls, ["/api/auth/session", "/api/database/status"]);
  resolveSession(response(200, { csrf_token: "csrf" }));
  await Promise.resolve();
});

test("failed answers remove thinking and mark the user message unsaved", async () => {
  const { context, events, questionInput } = createFailedChatFixture();
  vm.runInNewContext(read("renderer/chat-controller.js"), context);
  context.window.chatController.bind({ showToast: () => events.push("toast") });

  await context.window.chatController.submitQuestion({ preventDefault: () => {} });

  assert.deepEqual(events, ["user", "thinking", "remove", "failed", "toast"]);
  assert.equal(questionInput.focused, true);
});

function createFailedChatFixture() {
  const questionInput = new FakeElement("input");
  questionInput.value = "question";
  const submitButton = new FakeElement("button");
  const events = [];
  const elements = new Map([
    ["#question-input", questionInput],
    ["#chat-form button[type='submit']", submitButton],
  ]);
  const conversationView = {
    appendUser: () => { events.push("user"); return { kind: "user" }; },
    appendThinking: () => { events.push("thinking"); return { kind: "thinking" }; },
    removeThinking: () => events.push("remove"),
    markFailed: () => events.push("failed"),
    resetComposer: () => { questionInput.value = ""; },
  };
  const window = {
    chatContext: { askDatabase: async () => { throw new Error("failed"); } },
    chatScopeSelector: { getSelectedScope: () => null },
    modelSelector: { getChatSelection: () => ({}), updateAvailability: () => {} },
    conversationView,
  };
  return {
    context: { document: { querySelector: (selector) => elements.get(selector) }, window },
    events, questionInput,
  };
}

function response(status, body) {
  return {
    ok: status >= 200 && status < 300, status,
    text: async () => JSON.stringify(body),
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
