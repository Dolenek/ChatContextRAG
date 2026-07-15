const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const formattedNumber = new Intl.NumberFormat("cs-CZ");

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(value) { this.values.add(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force;
    enabled ? this.values.add(value) : this.values.delete(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.classList = new FakeClassList();
    this.disabled = false;
    this.listeners = {};
    this.style = {};
    this.textContent = "";
    this.title = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList();
    value.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() { return this._className || ""; }
}

test("overview keeps its responsive styles isolated from shared panels", () => {
  const html = read("renderer/index.html");
  const stylesheet = read("renderer/overview.css");
  assert.match(html, /<link rel="stylesheet" href="overview\.css"/);
  assert.match(stylesheet, /@media \(max-width: 1350px\) and \(min-width: 521px\)/);
  assert.match(stylesheet, /repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(stylesheet, /@media \(max-width: 520px\)/);
});

test("overview renders independent status, breakdown, and chunk requests", async () => {
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 12345, total_source_messages: 491478 })],
    pages: [pageFixture({ chunks: [chunkFixture()] })],
  });

  await harness.controller.refresh();

  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0],
    formattedNumber.format(12345));
  assert.equal(harness.elements.get("#channel-total").textContent, "1 celkem");
  assert.equal(summaryLabel(harness.elements.get("#channel-counts")), "server");
  assert.equal(harness.elements.get("#database-chunks").children[0].children[1].textContent,
    "Safe content");
  assert.deepEqual(harness.requests.breakdownPages, [
    ["channels", 50, 0], ["authors", 50, 0], ["embedding-models", 50, 0],
  ]);
  assert.deepEqual(harness.requests.pages, [[50]]);
});

test("status updates retain metric cards and external SVG instances", async () => {
  const harness = createHarness({
    statuses: [statusFixture(), statusFixture({ total_chunks: 2 })],
    pages: [pageFixture()],
  });
  await harness.controller.refresh();
  const firstCard = harness.elements.get("#overview-stats").children[0];
  const iconUse = firstCard.children[0].children[0].children[0];

  await harness.controller.refreshStatus({ forceClient: true });

  assert.equal(iconUse.attributes.href, "assets/icon-sprite.svg#icon-layers");
  assert.equal(harness.elements.get("#overview-stats").children[0], firstCard);
  assert.equal(firstCard.children[0].children[0].children[0], iconUse);
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0], "2");
});

test("breakdown pagination appends a local page and retains its button", async () => {
  const authorButton = "#load-more-authors";
  const harness = createHarness({
    statuses: [statusFixture()], pages: [pageFixture()],
    breakdownPages: {
      channels: [countPage([{ label: "server", count: 2 }])],
      authors: [
        countPage([{ label: "Ada", count: 2 }], { total: 2, has_more: true, next_offset: 1 }),
        countPage([{ label: "Bob", count: 1 }], { total: 2, offset: 1 }),
      ],
      "embedding-models": [countPage([{ label: "embedding", count: 2 }])],
    },
  });
  await harness.controller.refresh();
  const button = harness.elements.get(authorButton);

  await harness.breakdowns.loadNext("authors");

  assert.equal(harness.elements.get("#author-counts").children.length, 2);
  assert.equal(harness.elements.get(authorButton), button);
  assert.deepEqual(harness.requests.breakdownPages.at(-1), ["authors", 50, 1]);
});

test("failed breakdown page keeps its local retry control", async () => {
  const harness = createHarness({
    statuses: [statusFixture()], pages: [pageFixture()],
    breakdownPages: {
      channels: [countPage([])],
      authors: [new Error("Authors unavailable"), countPage([
        { label: "Ada", count: 2 },
      ])],
      "embedding-models": [countPage([])],
    },
  });
  await harness.controller.refresh();
  const retryButton = harness.elements.get("#load-more-authors");
  assert.equal(retryButton.textContent, "Zkusit znovu");

  await harness.breakdowns.loadNext("authors");

  assert.equal(harness.elements.get("#load-more-authors"), retryButton);
  assert.equal(summaryLabel(harness.elements.get("#author-counts")), "Ada");
});

test("overview appends cursor pages without repeating the first page", async () => {
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 2 })],
    pages: [
      pageFixture({
        chunks: [chunkFixture({ chunk_id: "first-chunk" })],
        has_more: true, next_cursor: "cursor-1",
      }),
      pageFixture({ chunks: [chunkFixture({ chunk_id: "second-chunk" })] }),
    ],
  });
  await harness.controller.refresh();
  await harness.controller.loadMore();

  assert.deepEqual(harness.requests.pages, [[50], [50, "cursor-1"]]);
  assert.equal(harness.elements.get("#database-chunks").children.length, 2);
  assert.equal(harness.elements.get("#chunk-range").textContent, "Zobrazeno 2 z 2");
});

test("a failed status refresh keeps the last rendered snapshot", async () => {
  const harness = createHarness({
    statuses: [statusFixture(), new Error("Database unavailable")],
    pages: [pageFixture()],
  });
  await harness.controller.refresh();
  const retainedMetric = metricValues(harness.elements.get("#overview-stats"))[0];

  const failedResult = await harness.controller.refreshStatus({ forceClient: true });

  assert.equal(failedResult.total_chunks, 0);
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0], retainedMetric);
  assert.deepEqual(harness.toasts.at(-1), ["Database unavailable", true]);
});

test("refresh exposes stable accessible loading without clearing cards", async () => {
  const deferredStatus = deferred();
  const harness = createHarness({ statuses: [deferredStatus.promise], pages: [pageFixture()] });
  const firstCard = harness.elements.get("#overview-stats").children[0];

  const refreshPromise = harness.controller.refresh();
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, true);
  assert.equal(harness.elements.get("#overview-stats").children[0], firstCard);
  deferredStatus.resolve(statusFixture());
  await refreshPromise;
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, false);
});

test("summary freshness state is announced without replacing metrics", async () => {
  const harness = createHarness({
    statuses: [
      statusFixture({ summary_refreshing: true, summary_is_stale: true }),
      statusFixture({ summary_is_stale: true }),
    ],
    pages: [pageFixture()],
  });
  await harness.controller.refresh();
  const state = harness.elements.get("#overview-summary-state");
  assert.equal(state.textContent, "Aktualizuji souhrn…");
  assert.equal(state.attributes["aria-busy"], "true");

  await harness.controller.refreshStatus({ forceClient: true });

  assert.equal(state.textContent, "Souhrn čeká na obnovení");
  assert.equal(state.attributes["aria-busy"], "false");
});

test("workspace cache coalesces requests and revalidates invalidated values", async () => {
  const context = { document: { querySelector: () => new FakeElement() }, window: {} };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  const first = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return first.promise; };

  const firstLoad = context.window.workspaceCache.load("status", loader, 5000);
  const joinedLoad = context.window.workspaceCache.load("status", loader, 5000);
  await Promise.resolve();
  assert.equal(calls, 1);
  first.resolve({ version: 1 });
  assert.deepEqual(await firstLoad, { version: 1 });
  assert.deepEqual(await joinedLoad, { version: 1 });

  context.window.workspaceCache.invalidate("status");
  const refreshed = await context.window.workspaceCache.load(
    "status", async () => { calls += 1; return { version: 2 }; }, 5000,
  );
  assert.equal(calls, 2);
  assert.deepEqual(refreshed, { version: 2 });
});

test("cache invalidation prevents an old response from becoming fresh", async () => {
  const context = { document: { querySelector: () => new FakeElement() }, window: {} };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  const oldRequest = deferred();
  const oldLoad = context.window.workspaceCache.load(
    "status", () => oldRequest.promise, 5000,
  );
  await Promise.resolve();
  context.window.workspaceCache.invalidate("status");
  const newLoad = context.window.workspaceCache.load(
    "status", async () => ({ version: 2 }), 5000, true,
  );
  oldRequest.resolve({ version: 1 });
  await oldLoad;
  assert.deepEqual(await newLoad, { version: 2 });
  assert.deepEqual(context.window.workspaceCache.peek("status"), { version: 2 });
});

function createHarness(input) {
  const elements = overviewElements();
  const requests = { status: 0, breakdownPages: [], pages: [] };
  const toasts = [];
  const breakdownPages = input.breakdownPages || defaultBreakdownPages();
  const context = {
    document: {
      hidden: false, addEventListener: () => {},
      querySelector: (selector) => elements.get(selector),
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    window: { setTimeout: () => 1, clearTimeout: () => {} },
  };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  context.window.chatContext = {
    getDatabaseStatus: async () => {
      requests.status += 1;
      return nextResponse(input.statuses);
    },
    getDatabaseBreakdownPage: async (dimension, limit, offset) => {
      requests.breakdownPages.push([dimension, limit, offset]);
      return nextResponse(breakdownPages[dimension]);
    },
    getDatabaseChunkPage: async (...arguments_) => {
      requests.pages.push(arguments_);
      return nextResponse(input.pages);
    },
  };
  context.window.archiveStatus = { render: () => {} };
  context.window.indexingControls = { render: () => {} };
  context.window.appUi = { showToast: (...arguments_) => toasts.push(arguments_) };
  vm.runInNewContext(read("renderer/overview-metrics-view.js"), context);
  vm.runInNewContext(read("renderer/overview-breakdowns-view.js"), context);
  vm.runInNewContext(read("renderer/overview-controller.js"), context);
  return {
    controller: context.window.overviewController,
    breakdowns: context.window.overviewBreakdownsView,
    elements, requests, toasts,
  };
}

function overviewElements() {
  const selectors = [
    "#overview-stats", "#overview-status-stats", "#channel-total", "#author-total",
    "#model-total", "#channel-counts", "#author-counts", "#model-counts",
    "#database-chunks", "#chunk-range", "#load-more-chunks-button",
    "#refresh-overview-button", "#refresh-overview-label", "#overview-summary-state",
    "#load-more-channels", "#load-more-authors", "#load-more-models",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  ["#load-more-chunks-button", "#load-more-channels", "#load-more-authors",
    "#load-more-models"].forEach((selector) => elements.get(selector).classList.add("hidden"));
  return elements;
}

function defaultBreakdownPages() {
  return {
    channels: [countPage([{ label: "server", count: 2 }])],
    authors: [countPage([{ label: "Ada", count: 2 }])],
    "embedding-models": [countPage([{ label: "embedding", count: 2 }])],
  };
}

function statusFixture(overrides = {}) {
  return {
    total_chunks: 0, total_source_messages: 0, raw_message_count: 0,
    unique_content_count: 0, duplicate_message_count: 0, indexed_message_count: 0,
    pending_message_count: 0, database_size: "0 bytes", total_channels: 3,
    total_authors: 1, oldest_message_at: null, newest_message_at: null,
    indexing_jobs: [], summary_is_stale: false, summary_refreshing: false,
    ...overrides,
  };
}

function countPage(items, overrides = {}) {
  return {
    items, total: items.length, limit: 50, offset: 0,
    has_more: false, next_offset: null, ...overrides,
  };
}

function pageFixture(overrides = {}) {
  return { chunks: [], has_more: false, next_cursor: null, ...overrides };
}

function chunkFixture(overrides = {}) {
  return {
    chunk_id: "chunk-1234567890", channel: "General", authors: ["Alice"],
    started_at: "2026-07-13T12:00:00Z", content: "Safe content",
    embedding_model: "embedding", source_message_ids: ["1", "2"], ...overrides,
  };
}

function nextResponse(responses) {
  const response = responses.shift();
  if (response instanceof Error) throw response;
  return response;
}

function metricValues(container) {
  return container.children.map((card) => card.children[1].children[0].textContent);
}

function summaryLabel(container) {
  return container.children[0].children[1].textContent;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
