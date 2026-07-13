const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
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
  constructor(id = "") {
    this.id = id;
    this.attributes = {};
    this.classList = new FakeClassList();
    this.dataset = {};
    this.listeners = {};
    this.style = {};
    this.textContent = "";
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  toggleAttribute(name, force) {
    if (force) this.attributes[name] = "";
    else delete this.attributes[name];
  }
  replaceChildren(...children) { this.children = children; }
}

test("renderer exposes the three-panel shell and responsive context drawer", () => {
  const html = read("renderer/index.html");
  const shellCss = read("renderer/shell.css");
  assert.match(html, /class="navigation-rail"/);
  assert.match(html, /id="left-drawer"/);
  assert.match(html, /id="context-panel"/);
  assert.match(html, /id="chat-screen" class="workspace-screen chat-screen"/);
  assert.doesNotMatch(html, /id="home-screen"/);
  assert.match(shellCss, /@media \(max-width: 1100px\)/);
  assert.match(shellCss, /\.context-panel\.open/);
});

test("shell opens the source drawer and switches workspaces", () => {
  const elements = createShellElements();
  const panels = ["sources", "discord", "discord-bot", "whatsapp", "import-result"]
    .map((name) => elements.get(`#${name}-drawer-panel`));
  const document = {
    body: new FakeElement("body"),
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) => selector === ".drawer-panel" ? panels : [],
    addEventListener: () => {},
  };
  const context = { document, window: { matchMedia: () => ({ matches: false }) } };
  vm.runInNewContext(read("renderer/shell-controller.js"), context);

  context.window.shellController.openDrawerPanel("sources");
  assert.equal(elements.get("#left-drawer").classList.contains("open"), true);
  assert.equal(elements.get("#left-drawer").attributes["aria-hidden"], "false");
  assert.equal(elements.get("#sources-drawer-panel").classList.contains("active"), true);

  context.window.shellController.showScreen("overview");
  assert.equal(elements.get("#chat-screen").classList.contains("hidden"), true);
  assert.equal(elements.get("#overview-screen").classList.contains("hidden"), false);
  assert.equal(elements.get("#open-overview-button").classList.contains("active"), true);
});

test("right panel renders sources and a safe zero-index state", () => {
  const elements = new Map([
    ["#context-list", new FakeElement()], ["#context-empty", new FakeElement()],
    ["#index-percent", new FakeElement()], ["#index-raw-count", new FakeElement()],
    ["#indexed-count", new FakeElement()], ["#index-chunk-count", new FakeElement()],
    ["#database-size", new FakeElement()], ["#index-last-update", new FakeElement()],
    [".index-progress", new FakeElement()], ["#index-progress-bar", new FakeElement()],
  ]);
  const sourceCard = new FakeElement("source");
  const context = {
    document: { querySelector: (selector) => elements.get(selector) },
    window: { chatSources: { createChatSourceCard: () => sourceCard } },
  };
  vm.runInNewContext(read("renderer/context-panel.js"), context);
  context.window.contextPanel.showSources([{ content: "grounded" }]);
  context.window.contextPanel.renderOverview({
    raw_message_count: 0, indexed_message_count: 0, total_chunks: 0,
    database_size: "0 bytes", pending_message_count: 0, indexing_jobs: [],
  });

  assert.deepEqual(elements.get("#context-list").children, [sourceCard]);
  assert.equal(elements.get("#context-empty").classList.contains("hidden"), true);
  assert.equal(elements.get("#index-percent").textContent, "—");
  assert.equal(elements.get("#index-progress-bar").style.width, "0%");

  context.window.contextPanel.renderOverview({
    raw_message_count: 100, indexed_message_count: 50, total_chunks: 12,
    database_size: "1 MB", pending_message_count: 50,
    indexing_jobs: [{ status: "queued" }, { status: "running" }],
  });
  assert.equal(elements.get("#index-last-update").textContent,
    "Indexace právě probíhá · ve frontě: 1");
});

test("embedded Discord reserves the expanded import drawer", () => {
  const { calculateDiscordBounds } = require("../electron/discord-view");
  assert.deepEqual(calculateDiscordBounds(1240, 820), {
    x: 360, y: 30, width: 880, height: 790,
  });
  assert.deepEqual(calculateDiscordBounds(840, 620), {
    x: 360, y: 30, width: 480, height: 590,
  });
});

function createShellElements() {
  const ids = [
    "left-drawer", "context-panel", "drawer-toggle", "drawer-title", "chat-screen",
    "overview-screen", "settings-screen", "open-chat-button", "open-overview-button",
    "open-settings-button", "drawer-close", "context-toggle", "context-close",
    "sources-drawer-panel", "discord-drawer-panel", "discord-bot-drawer-panel",
    "whatsapp-drawer-panel", "import-result-drawer-panel",
  ];
  return new Map(ids.map((id) => [`#${id}`, new FakeElement(id)]));
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
