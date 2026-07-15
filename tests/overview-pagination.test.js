const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");

const {
  FakeElement, chunkFixture, countPage, createHarness, deferred, pageFixture,
  read, statusFixture, summaryLabel,
} = require("./support/overview-harness");

test("breakdown pagination appends raw-message rows and retains its button", async () => {
  const harness = createHarness({
    statuses: [statusFixture()], pages: [pageFixture()],
    breakdownPages: {
      channels: [countPage([{ label: "server", count: 2 }])],
      authors: [
        countPage([{ label: "Ada", count: 2 }], {
          total: 2, has_more: true, next_offset: 1,
        }),
        countPage([{ label: "Bob", count: 1 }], { total: 2, offset: 1 }),
      ],
      "embedding-models": [countPage([{ label: "embedding", count: 2 }])],
    },
  });
  await harness.controller.refresh();
  const button = harness.elements.get("#load-more-authors");
  assert.equal(button.textContent, "Zobrazit dalších 50 autorů");

  await harness.breakdowns.loadNext("authors");

  assert.equal(harness.elements.get("#author-counts").children.length, 2);
  assert.equal(harness.elements.get("#load-more-authors"), button);
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

test("chunk table renders safe compact rows and appends cursor pages", async () => {
  const firstChunk = chunkFixture({
    chunk_id: "c3d71234567892f1", content: "<img src=x onerror=alert(1)>",
  });
  const harness = createHarness({
    statuses: [statusFixture({ total_chunks: 2 })],
    pages: [
      pageFixture({ chunks: [firstChunk], has_more: true, next_cursor: "cursor-1" }),
      pageFixture({ chunks: [chunkFixture({ chunk_id: "second-chunk" })] }),
    ],
  });
  await harness.controller.refresh();
  const firstRow = harness.elements.get("#database-chunks").children[0];
  assert.equal(firstRow.children[0].textContent, "c3d7…92f1");
  assert.equal(firstRow.children[0].title, "c3d71234567892f1");
  assert.equal(firstRow.children[1].textContent, "<img src=x onerror=alert(1)>");
  assert.match(firstRow.children[2].textContent, /15\. 7\. 2026/);
  assert.equal(harness.elements.get("#load-more-chunks-button").textContent,
    "Zobrazit dalších 50 záznamů");

  await harness.controller.loadMore();

  assert.deepEqual(harness.requests.pages, [[50], [50, "cursor-1"]]);
  assert.equal(harness.elements.get("#database-chunks").children.length, 2);
  assert.equal(harness.elements.get("#chunk-range").textContent, "Zobrazeno 2 z 2");
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
