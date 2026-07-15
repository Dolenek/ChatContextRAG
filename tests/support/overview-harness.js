const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..", "..");

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
  constructor(tagName = "div", registerId = () => {}) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.disabled = false;
    this.listeners = {};
    this.style = {};
    this.textContent = "";
    this.title = "";
    this.registerId = registerId;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  set id(value) { this._id = value; this.registerId(value, this); }
  get id() { return this._id || ""; }
  set className(value) {
    this._className = value;
    this.classList = new FakeClassList();
    value.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() { return this._className || ""; }
}

function createHarness(input) {
  const elements = overviewElements();
  const registerId = (id, createdElement) => elements.set(`#${id}`, createdElement);
  const requests = {
    status: 0, breakdownPages: [], pages: [], chatScopes: 0, settings: 0,
  };
  const toasts = [];
  const scheduledDelays = [];
  const breakdownPages = input.breakdownPages || defaultBreakdownPages();
  const context = {
    document: {
      hidden: false, addEventListener: () => {},
      querySelector: (selector) => elements.get(selector),
      createElement: (tagName) => new FakeElement(tagName, registerId),
      createElementNS: (_namespace, tagName) => new FakeElement(tagName, registerId),
    },
    window: {
      setTimeout: (_callback, delay) => { scheduledDelays.push(delay); return 1; },
      clearTimeout: () => {},
    },
  };
  vm.runInNewContext(read("renderer/workspace-state.js"), context);
  context.window.chatContext = createChatContext(input, breakdownPages, requests);
  context.window.archiveStatus = { render: () => {} };
  context.window.indexingControls = { render: () => {} };
  context.window.chatScopeSelector = {
    refresh: async () => { requests.chatScopes += 1; },
  };
  context.window.settingsUi = {
    refreshIndexState: async () => { requests.settings += 1; },
  };
  context.window.appUi = { showToast: (...arguments_) => toasts.push(arguments_) };
  vm.runInNewContext(read("renderer/overview-metrics-view.js"), context);
  vm.runInNewContext(read("renderer/overview-breakdowns-view.js"), context);
  vm.runInNewContext(read("renderer/overview-controller.js"), context);
  return {
    controller: context.window.overviewController,
    breakdowns: context.window.overviewBreakdownsView,
    context, elements, requests, scheduledDelays, toasts,
  };
}

function createChatContext(input, breakdownPages, requests) {
  return {
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
}

function overviewElements() {
  const selectors = [
    "#overview-summary", "#channel-total", "#author-total", "#model-total",
    "#channel-counts", "#author-counts", "#model-counts", "#database-chunks",
    "#chunk-range", "#load-more-chunks-button", "#refresh-overview-button",
    "#refresh-overview-label", "#load-more-channels", "#load-more-authors",
    "#load-more-models",
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
    indexing_jobs: [], summary_ready: true,
    summary_is_stale: false, summary_refreshing: false,
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
    started_at: "2026-07-13T12:00:00Z", updated_at: "2026-07-15T10:54:59Z",
    content: "Safe content", embedding_model: "embedding",
    source_message_ids: ["1", "2"], ...overrides,
  };
}

function summaryMetric(summary, cardIndex, rowIndex) {
  return summary.children[1].children[cardIndex].children[1]
    .children[rowIndex].children[1];
}

function bannerMetric(summary, metricIndex) {
  return summary.children[0].children[metricIndex].children[1];
}

function bannerDescription(summary) {
  return summary.children[0].children[0].children[1].children[1];
}

function summaryLabel(container) {
  return container.children[0].children[1].textContent;
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function nextResponse(responses) {
  const response = responses.shift();
  if (response instanceof Error) throw response;
  return response;
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

module.exports = {
  FakeElement, bannerDescription, bannerMetric, chunkFixture, countPage,
  createHarness, deferred, pageFixture, read, statusFixture, summaryLabel,
  summaryMetric,
};
