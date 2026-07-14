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
  const panelCss = read("renderer/panels.css");
  assert.match(html, /id="primary-navigation" class="navigation-rail"/);
  assert.match(html, /id="navigation-toggle"/);
  assert.match(html, /class="rail-label">Zdroje a importy/);
  assert.match(html, /aria-controls="left-drawer" aria-expanded="false"/);
  assert.match(html, /id="drawer-close"[^>]+aria-label="Zavřít panel zdrojů"/);
  assert.match(html, /id="left-drawer"/);
  assert.match(html, /id="context-panel"/);
  assert.match(html, /id="chat-screen" class="workspace-screen chat-screen"/);
  assert.doesNotMatch(html, /id="home-screen"/);
  assert.match(shellCss, /@media \(max-width: 1100px\)/);
  assert.match(shellCss, /@media \(max-width: 700px\)/);
  assert.match(shellCss, /prefers-reduced-motion: reduce/);
  assert.match(shellCss, /var\(--rail-expanded-width\)/);
  assert.match(shellCss, /\.context-panel\.open/);
  assert.match(shellCss, /\.context-scroll[\s\S]+display: flex[\s\S]+flex-direction: column/);
  assert.match(panelCss, /\.index-panel \{ margin-top: auto/);
  assert.doesNotMatch(html, /Data zůstávají (?:lokálně|na serveru)/);
  assert.doesNotMatch(html, /class="(?:local-status|privacy-card)"/);
  assert.doesNotMatch(read("renderer/runtime-bridge.js"), /localStatus/);
  assert.match(html, /id="settings-overlay"/);
  assert.doesNotMatch(html, /id="settings-screen"/);
});

test("shell opens the source drawer and switches workspaces", () => {
  const { context, elements } = createShellFixture();

  context.window.shellController.openDrawerPanel("sources");
  assert.equal(elements.get("#left-drawer").classList.contains("open"), true);
  assert.equal(elements.get("#left-drawer").attributes["aria-hidden"], "false");
  assert.equal(elements.get("#sources-drawer-panel").classList.contains("active"), true);
  assert.equal(elements.get("#open-sources-button").attributes["aria-expanded"], "true");
  assert.equal(elements.get("#open-sources-button").classList.contains("drawer-active"), true);

  context.window.shellController.showScreen("overview");
  assert.equal(elements.get("#chat-screen").classList.contains("hidden"), true);
  assert.equal(elements.get("#overview-screen").classList.contains("hidden"), false);
  assert.equal(elements.get("#open-overview-button").classList.contains("active"), true);
});

test("navigation defaults to expanded and persists direct desktop toggles", () => {
  const { context, document, elements, storageWrites } = createShellFixture();
  const toggle = elements.get("#navigation-toggle");

  assert.equal(document.body.classList.contains("navigation-expanded"), true);
  assert.equal(document.body.dataset.navigationMode, "expanded");
  assert.equal(toggle.attributes["aria-expanded"], "true");
  assert.equal(elements.get("#navigation-toggle-label").textContent, "Sbalit navigaci");

  toggle.listeners.click();
  assert.equal(document.body.classList.contains("navigation-expanded"), false);
  assert.equal(toggle.attributes["aria-label"], "Rozbalit navigaci");
  assert.deepEqual(storageWrites, [["chat-context.navigation-mode", "collapsed"]]);

  context.window.shellController.toggleNavigation();
  assert.equal(document.body.classList.contains("navigation-expanded"), true);
  assert.deepEqual(storageWrites.at(-1), ["chat-context.navigation-mode", "expanded"]);
});

test("navigation restores valid preferences and tolerates unavailable storage", () => {
  const collapsed = createShellFixture({ storedMode: "collapsed" });
  assert.equal(collapsed.document.body.dataset.navigationMode, "collapsed");

  const invalid = createShellFixture({ storedMode: "unexpected" });
  assert.equal(invalid.document.body.dataset.navigationMode, "expanded");

  const unavailable = createShellFixture({ storageThrows: true });
  unavailable.elements.get("#navigation-toggle").listeners.click();
  assert.equal(unavailable.document.body.dataset.navigationMode, "collapsed");
});

test("narrow navigation is transient and Discord restores the desktop preference", () => {
  const narrow = createShellFixture({ narrow: true, storedMode: "expanded" });
  assert.equal(narrow.document.body.dataset.navigationMode, "collapsed");
  narrow.context.window.shellController.toggleNavigation();
  assert.equal(narrow.document.body.dataset.navigationMode, "expanded");
  assert.deepEqual(narrow.storageWrites, []);

  const desktop = createShellFixture({ storedMode: "expanded" });
  desktop.context.window.shellController.setDiscordActive(true);
  assert.equal(desktop.document.body.dataset.navigationMode, "collapsed");
  assert.equal(desktop.elements.get("#navigation-toggle").disabled, true);
  assert.deepEqual(desktop.storageWrites, []);

  desktop.context.window.shellController.setDiscordActive(false);
  assert.equal(desktop.document.body.dataset.navigationMode, "expanded");
  assert.equal(desktop.elements.get("#navigation-toggle").disabled, false);
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
    "left-drawer", "context-panel", "navigation-toggle", "navigation-toggle-label",
    "drawer-title", "chat-screen", "open-sources-button",
    "overview-screen", "open-chat-button", "open-overview-button",
    "open-settings-button", "drawer-close", "context-toggle", "context-close",
    "sources-drawer-panel", "discord-drawer-panel", "discord-bot-drawer-panel",
    "whatsapp-drawer-panel", "import-result-drawer-panel",
  ];
  return new Map(ids.map((id) => [`#${id}`, new FakeElement(id)]));
}

function createShellFixture(options = {}) {
  const elements = createShellElements();
  const panels = ["sources", "discord", "discord-bot", "whatsapp", "import-result"]
    .map((name) => elements.get(`#${name}-drawer-panel`));
  const documentListeners = {};
  const document = {
    body: new FakeElement("body"),
    querySelector: (selector) => elements.get(selector),
    querySelectorAll: (selector) => selector === ".drawer-panel" ? panels : [],
    addEventListener: (name, callback) => { documentListeners[name] = callback; },
  };
  const storageWrites = [];
  const localStorage = {
    getItem: () => {
      if (options.storageThrows) throw new Error("storage unavailable");
      return options.storedMode ?? null;
    },
    setItem: (key, value) => {
      if (options.storageThrows) throw new Error("storage unavailable");
      storageWrites.push([key, value]);
    },
  };
  const window = {
    localStorage,
    matchMedia: (query) => ({ matches: options.narrow && query.includes("700px") }),
    addEventListener: () => {},
  };
  const context = { document, window };
  vm.runInNewContext(read("renderer/shell-controller.js"), context);
  return { context, document, documentListeners, elements, storageWrites };
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
