const assert = require("node:assert/strict");
const test = require("node:test");

const {
  bannerDescription, bannerMetric, chunkFixture, countPage, createHarness,
  deferred, pageFixture, read, statusFixture, summaryLabel, summaryMetric,
} = require("./support/overview-harness");

const formattedNumber = new Intl.NumberFormat("cs-CZ");

test("overview exposes the compact dashboard structure and responsive styles", () => {
  const html = read("renderer/index.html");
  const stylesheet = read("renderer/overview.css");

  assert.match(html, /id="overview-summary"/);
  assert.match(html, /Název<\/span><span>Zprávy/);
  assert.match(html, /Model<\/span><span>Chunky/);
  assert.match(html, /ID<\/span><span>Obsah<\/span><span>Uloženo/);
  assert.match(stylesheet, /overview-archive-banner::after/);
  assert.match(stylesheet, /--overview-metric-row-height: 22px/);
  assert.match(stylesheet, /min-height: var\(--overview-metric-row-height\)/);
  assert.match(stylesheet, /font-size: var\(--overview-font-body\)/);
  assert.match(stylesheet, /@media \(max-width: 850px\)/);
  assert.match(stylesheet, /repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(stylesheet, /@media \(max-width: 520px\)/);
});

test("overview renders status, raw-message breakdowns, and chunk rows independently", async () => {
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 12345, total_source_messages: 491478 })],
    pages: [pageFixture({ chunks: [chunkFixture()] })],
  });

  await harness.controller.refresh();

  assert.equal(summaryMetric(harness.elements.get("#overview-summary"), 0, 0).textContent,
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

test("status updates retain summary rows and external SVG instances", async () => {
  const harness = createHarness({
    statuses: [statusFixture(), statusFixture({ total_chunks: 2 })],
    pages: [pageFixture()],
  });
  const summary = harness.elements.get("#overview-summary");
  const firstRow = summary.children[1].children[0].children[1].children[0];
  const iconUse = firstRow.children[0].children[0].children[0].children[0];

  await harness.controller.refresh();
  await harness.controller.refreshStatus({ forceClient: true });

  assert.equal(iconUse.attributes.href, "assets/icon-sprite.svg#icon-layers");
  assert.equal(summary.children[1].children[0].children[1].children[0], firstRow);
  assert.equal(summaryMetric(summary, 0, 0).textContent, "2");
});

test("archive banner reports complete and active indexing readiness", async () => {
  const harness = createHarness({
    statuses: [
      statusFixture({ raw_message_count: 100, indexed_message_count: 100 }),
      statusFixture({
        raw_message_count: 100, indexed_message_count: 50,
        pending_message_count: 50, indexing_jobs: [{ status: "running" }],
      }),
    ],
    pages: [pageFixture()],
  });
  const summary = harness.elements.get("#overview-summary");

  await harness.controller.refresh();
  assert.equal(bannerMetric(summary, 1).textContent, "100 %");
  assert.equal(bannerDescription(summary).textContent,
    "Archiv je kompletní a připraven k dotazování.");
  const progress = summary.children[1].children[1].children[2].children[1];
  assert.equal(progress.attributes["aria-valuenow"], "100");

  await harness.controller.refreshStatus({ forceClient: true });
  assert.equal(bannerMetric(summary, 1).textContent, "50 %");
  assert.equal(bannerDescription(summary).textContent, "Archiv se právě indexuje.");
  assert.equal(progress.attributes["aria-valuenow"], "50");
});

test("empty archive and initial projection use truthful placeholders", async () => {
  const emptyHarness = createHarness({
    statuses: [statusFixture()], pages: [pageFixture()],
  });
  await emptyHarness.controller.refresh();
  const emptySummary = emptyHarness.elements.get("#overview-summary");
  assert.equal(bannerMetric(emptySummary, 1).textContent, "—");
  assert.equal(bannerDescription(emptySummary).textContent,
    "Archiv je prázdný a čeká na první zprávy.");

  const preparingHarness = createHarness({
    statuses: [statusFixture({ summary_ready: false, summary_refreshing: true })],
    pages: [pageFixture()],
    breakdownPages: Object.fromEntries(
      ["channels", "authors", "embedding-models"].map(
        (dimension) => [dimension, [countPage([], { summary_ready: false })]],
      ),
    ),
  });
  await preparingHarness.controller.refresh();
  const preparingSummary = preparingHarness.elements.get("#overview-summary");
  assert.equal(summaryMetric(preparingSummary, 0, 0).textContent, "—");
  assert.equal(bannerMetric(preparingSummary, 3).textContent, "0 bytes");
  assert.equal(preparingHarness.elements.get("#chunk-range").textContent,
    "Zobrazeno 0 z —");
  assert.equal(preparingHarness.elements.get("#overview-summary-state").textContent,
    "Připravuji souhrn…");
  assert.equal(preparingHarness.scheduledDelays.at(-1), 8000);
});

test("failed status refresh keeps the last rendered snapshot", async () => {
  const harness = createHarness({
    statuses: [statusFixture(), new Error("Database unavailable")],
    pages: [pageFixture()],
  });
  await harness.controller.refresh();
  const retainedMetric = summaryMetric(
    harness.elements.get("#overview-summary"), 0, 0,
  ).textContent;

  const failedResult = await harness.controller.refreshStatus({ forceClient: true });

  assert.equal(failedResult.total_chunks, 0);
  assert.equal(summaryMetric(harness.elements.get("#overview-summary"), 0, 0).textContent,
    retainedMetric);
  assert.deepEqual(harness.toasts.at(-1), ["Database unavailable", true]);
});

test("refresh exposes stable accessible loading without clearing summary rows", async () => {
  const deferredStatus = deferred();
  const harness = createHarness({
    statuses: [deferredStatus.promise], pages: [pageFixture()],
  });
  const summary = harness.elements.get("#overview-summary");
  const firstRow = summary.children[1].children[0].children[1].children[0];

  const refreshPromise = harness.controller.refresh();
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, true);
  assert.equal(summary.attributes["aria-busy"], "true");
  assert.equal(summary.children[1].children[0].children[1].children[0], firstRow);
  deferredStatus.resolve(statusFixture());
  await refreshPromise;
  assert.equal(harness.elements.get("#refresh-overview-button").disabled, false);
  assert.equal(summary.attributes["aria-busy"], "false");
});

test("summary freshness is announced without replacing visible metrics", async () => {
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

test("completed projection refreshes every projection consumer", async () => {
  const harness = createHarness({
    statuses: [
      statusFixture({ summary_is_stale: true, summary_refreshing: true }),
      statusFixture({ summary_generated_at: "2026-07-15T12:00:00Z" }),
    ],
    pages: [pageFixture()],
  });
  await harness.controller.refresh();

  await harness.controller.refreshStatus({ forceClient: true });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(harness.requests.chatScopes, 1);
  assert.equal(harness.requests.settings, 1);
  assert.equal(harness.requests.breakdownPages.length, 6);
});
