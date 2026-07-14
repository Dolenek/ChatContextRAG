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
  assert.match(stylesheet, /overview-breakdowns \{ grid-template-columns: 1fr; \}/);
});

test("overview renders ordered metric groups and safe summary lists", async () => {
  const overview = overviewFixture({
    total_chunks: 12345,
    total_source_messages: 491478,
    channels: [{ label: "<server>", count: 43953 }],
    authors: [{ label: "Amélie", count: 7073 }],
    embedding_models: [{ label: "text-embedding-3-small", count: 12345 }],
    chunks: [chunkFixture()],
  });
  const harness = createHarness([overview]);

  await harness.controller.refresh();

  assert.deepEqual(metricLabels(harness.elements.get("#overview-stats")), [
    "Chunky", "Zdrojové zprávy", "Raw zprávy", "Unikátní texty",
    "Přesné duplicity", "Zaindexované zprávy",
  ]);
  assert.deepEqual(metricLabels(harness.elements.get("#overview-status-stats")), [
    "Čeká na index", "Velikost databáze", "Konverzace",
    "Nejstarší zpráva", "Nejnovější zpráva",
  ]);
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0],
    formattedNumber.format(12345));
  assert.equal(harness.elements.get("#channel-total").textContent, "3 celkem");
  assert.equal(summaryLabel(harness.elements.get("#channel-counts")), "<server>");
  assert.equal(summaryCount(harness.elements.get("#channel-counts")),
    formattedNumber.format(43953));
  assert.equal(harness.elements.get("#database-chunks").children[0].children[1].textContent,
    "Bezpečný obsah");
});

test("overview appends chunk pages without changing the public paging contract", async () => {
  const firstPage = overviewFixture({
    total_chunks: 2, chunks: [chunkFixture({ chunk_id: "first-chunk" })], has_more: true,
  });
  const secondPage = overviewFixture({
    total_chunks: 2, offset: 1,
    chunks: [chunkFixture({ chunk_id: "second-chunk", content: "Druhý" })],
  });
  const harness = createHarness([firstPage, secondPage]);

  await harness.controller.refresh();
  await harness.controller.loadMore();

  assert.deepEqual(harness.requests, [[50, 0], [50, 1]]);
  assert.equal(harness.elements.get("#database-chunks").children.length, 2);
  assert.equal(harness.elements.get("#chunk-range").textContent, "Zobrazeno 2 z 2");
  assert.equal(harness.elements.get("#load-more-chunks-button").classList.contains("hidden"), true);
});

test("empty overview stays visible when a later refresh fails", async () => {
  const harness = createHarness([
    overviewFixture(), new Error("Databáze není dostupná"),
  ]);
  await harness.controller.refresh();
  const retainedEmptyState = harness.elements.get("#database-chunks").children[0];

  const failedResult = await harness.controller.refresh();

  assert.equal(failedResult, null);
  assert.equal(harness.elements.get("#database-chunks").children[0], retainedEmptyState);
  assert.equal(retainedEmptyState.textContent, "Databáze zatím neobsahuje žádné chunky.");
  assert.equal(metricValues(harness.elements.get("#overview-stats"))[0], "0");
  assert.deepEqual(metricValues(harness.elements.get("#overview-status-stats")).slice(3),
    ["Bez času", "Bez času"]);
  assert.equal(harness.elements.get("#channel-counts").children[0].textContent, "Zatím bez dat");
  assert.deepEqual(harness.toasts, [["Databáze není dostupná", true]]);
});

test("refresh exposes a stable accessible loading state", async () => {
  const deferredOverview = deferred();
  const harness = createHarness([deferredOverview.promise]);

  const refreshPromise = harness.controller.refresh();
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, true);
  assert.equal(harness.elements.get("#refresh-overview-button").attributes["aria-busy"], "true");
  assert.equal(harness.elements.get("#refresh-overview-label").textContent, "Načítám…");

  deferredOverview.resolve(overviewFixture());
  await refreshPromise;
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, false);
  assert.equal(harness.elements.get("#refresh-overview-button").attributes["aria-busy"], "false");
  assert.equal(harness.elements.get("#refresh-overview-label").textContent, "Obnovit");
});

function createHarness(responses) {
  const elements = overviewElements();
  const requests = [];
  const toasts = [];
  const context = {
    document: {
      querySelector: (selector) => elements.get(selector),
      createElement: (tagName) => new FakeElement(tagName),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    },
    window: {
      chatContext: { getDatabaseOverview: async (...arguments_) => {
        requests.push(arguments_);
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return response;
      } },
      archiveStatus: { render: () => {} },
      indexingControls: { render: () => {} },
      appUi: { showToast: (...arguments_) => toasts.push(arguments_) },
    },
  };
  vm.runInNewContext(read("renderer/overview-controller.js"), context);
  return { controller: context.window.overviewController, elements, requests, toasts };
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

function overviewFixture(overrides = {}) {
  return {
    total_chunks: 0, total_source_messages: 0, raw_message_count: 0,
    unique_content_count: 0, duplicate_message_count: 0, indexed_message_count: 0,
    pending_message_count: 0, database_size: "0 bytes", total_channels: 3,
    total_authors: 1, oldest_message_at: null, newest_message_at: null,
    channels: [], authors: [], embedding_models: [], chunks: [], indexing_jobs: [],
    offset: 0, has_more: false, ...overrides,
  };
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

function summaryCount(container) {
  return container.children[0].children[2].textContent;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
