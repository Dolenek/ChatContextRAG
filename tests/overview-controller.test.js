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
    this.textContent = "";
    this.title = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
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

test("overview renders status, breakdowns, and chunks from independent requests", async () => {
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 12345, total_source_messages: 491478 })],
    breakdowns: [breakdownFixture()],
    pages: [pageFixture({ chunks: [chunkFixture()] })],
  });

  await harness.controller.refresh();

  assert.deepEqual(metricLabels(harness.elements.get("#overview-stats")), [
    "Chunky", "Zdrojové zprávy", "Raw zprávy", "Unikátní texty",
    "Přesné duplicity", "Zaindexované zprávy",
  ]);
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0],
    formattedNumber.format(12345));
  assert.equal(harness.elements.get("#channel-total").textContent, "3 celkem");
  assert.equal(summaryLabel(harness.elements.get("#channel-counts")), "<server>");
  assert.equal(harness.elements.get("#database-chunks").children[0].children[1].textContent,
    "Bezpečný obsah");
  assert.deepEqual(harness.requests, { status: 1, breakdowns: 1, pages: [[50]] });
});

test("overview appends cursor pages without repeating the first page", async () => {
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 2 })],
    breakdowns: [breakdownFixture()],
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
    statuses: [statusFixture(), new Error("Databáze není dostupná")],
    breakdowns: [breakdownFixture()], pages: [pageFixture()],
  });
  await harness.controller.refresh();
  const retainedMetric = metricValues(harness.elements.get("#overview-stats"))[0];

  const failedResult = await harness.controller.refreshStatus(true);

  assert.equal(failedResult.total_chunks, 0);
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0], retainedMetric);
  assert.deepEqual(harness.toasts.at(-1), ["Databáze není dostupná", true]);
});

test("refresh exposes a stable accessible loading state", async () => {
  const deferredStatus = deferred();
  const harness = createHarness({
    statuses: [deferredStatus.promise],
    breakdowns: [breakdownFixture()], pages: [pageFixture()],
  });

  const refreshPromise = harness.controller.refresh();
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, true);
  assert.equal(harness.elements.get("#refresh-overview-label").textContent, "Načítám…");
  deferredStatus.resolve(statusFixture());
  await refreshPromise;
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, false);
  assert.equal(harness.elements.get("#refresh-overview-label").textContent, "Obnovit");
});

test("workspace cache coalesces requests and revalidates invalidated values", async () => {
  const context = { document: { querySelector: () => new FakeElement() }, window: {} };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  const first = deferred();
  let calls = 0;
  const loader = () => { calls += 1; return first.promise; };

  const firstLoad = context.window.workspaceCache.load("status", loader, 5000);
  const joinedLoad = context.window.workspaceCache.load("status", loader, 5000);
  assert.equal(calls, 0);
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

test("cache invalidation does not let an older in-flight response become fresh", async () => {
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
  const requests = { status: 0, breakdowns: 0, pages: [] };
  const toasts = [];
  const context = {
    document: {
      querySelector: (selector) => elements.get(selector),
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    window: {},
  };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  context.window.chatContext = {
    getDatabaseStatus: async () => {
      requests.status += 1;
      return nextResponse(input.statuses);
    },
    getDatabaseBreakdowns: async () => {
      requests.breakdowns += 1;
      return nextResponse(input.breakdowns);
    },
    getDatabaseChunkPage: async (...arguments_) => {
      requests.pages.push(arguments_);
      return nextResponse(input.pages);
    },
  };
  context.window.archiveStatus = { render: () => {} };
  context.window.indexingControls = { render: () => {} };
  context.window.appUi = { showToast: (...arguments_) => toasts.push(arguments_) };
  vm.runInNewContext(read("renderer/overview-controller.js"), context);
  return { controller: context.window.overviewController, elements, requests, toasts };
}

function nextResponse(responses) {
  const response = responses.shift();
  if (response instanceof Error) throw response;
  return response;
}

function overviewElements() {
  const selectors = [
    "#overview-stats", "#overview-status-stats", "#channel-total", "#author-total",
    "#model-total", "#channel-counts", "#author-counts", "#model-counts",
    "#database-chunks", "#chunk-range", "#load-more-chunks-button",
    "#refresh-overview-button", "#refresh-overview-label",
  ];
  const elements = new Map(selectors.map((selector) => [selector, new FakeElement()]));
  elements.get("#load-more-chunks-button").classList.add("hidden");
  return elements;
}

function statusFixture(overrides = {}) {
  return {
    total_chunks: 0, total_source_messages: 0, raw_message_count: 0,
    unique_content_count: 0, duplicate_message_count: 0, indexed_message_count: 0,
    pending_message_count: 0, database_size: "0 bytes", total_channels: 3,
    total_authors: 1, oldest_message_at: null, newest_message_at: null,
    indexing_jobs: [], ...overrides,
  };
}

function breakdownFixture(overrides = {}) {
  return {
    channels: [{ label: "<server>", count: 43953 }],
    authors: [{ label: "Amélie", count: 7073 }],
    embedding_models: [{ label: "text-embedding-3-small", count: 12345 }],
    ...overrides,
  };
}

function pageFixture(overrides = {}) {
  return { chunks: [], has_more: false, next_cursor: null, ...overrides };
}

function chunkFixture(overrides = {}) {
  return {
    chunk_id: "chunk-1234567890", channel: "General", authors: ["Alice"],
    started_at: "2026-07-13T12:00:00Z", content: "Bezpečný obsah",
    embedding_model: "text-embedding-3-small", source_message_ids: ["1", "2"],
    ...overrides,
  };
}

function metricLabels(container) {
  return container.children.map((card) => card.children[1].children[1].textContent);
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
