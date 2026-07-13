const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor() {
    this.children = [];
    this.dataset = {};
    this.disabled = false;
    this.style = {};
    this.attributes = {};
    this.textContent = "";
    this.listeners = {};
    this.classList = { contains: () => false };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener(name, callback) {
    this.listeners[name] = callback;
  }

  setAttribute(name, value) {
    this.attributes[name] = value;
  }
}

function loadControls(jobResponse = null) {
  const elements = new Map([
    ["#indexing-jobs", new FakeElement()],
    ["#index-pending-button", new FakeElement()],
    ["#overview-screen", new FakeElement()],
  ]);
  const scheduledCallbacks = [];
  const context = {
    window: {
      chatContext: {
        getIndexingJob: async (jobId) => typeof jobResponse === "function"
          ? jobResponse(jobId) : jobResponse,
      },
      clearTimeout: () => {},
      setTimeout: (callback) => {
        scheduledCallbacks.push(callback);
        return scheduledCallbacks.length;
      },
    },
    document: {
      createElement: () => new FakeElement(),
      querySelector: (selector) => elements.get(selector),
    },
  };
  const source = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "indexing-controls.js"), "utf8",
  );
  vm.runInNewContext(source, context);
  return { controls: context.window.indexingControls, elements, scheduledCallbacks };
}

test("pending indexing action reflects uncovered messages and active jobs", () => {
  const { controls, elements } = loadControls();
  const button = elements.get("#index-pending-button");

  controls.render([], 84);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Zaindexovat čekající (84)");

  controls.render([{
    job_id: "queued", status: "queued", processed_messages: 0,
    total_messages: 84, stored_chunks: 0,
  }], 84);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Indexování čeká ve frontě · 1");

  controls.render([{
    job_id: "job-1", status: "running", processed_messages: 10,
    total_messages: 84, stored_chunks: 2,
  }], 84);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Indexování běží…");
  const jobRow = elements.get("#indexing-jobs").children[0];
  assert.equal(jobRow.children[0].children[0].textContent, "Indexuji · 11 %");
  assert.equal(jobRow.children[1].textContent, "10 z 84 zpráv");
  assert.equal(jobRow.children[2].children[0].style.width, "11%");
});

test("zero progress explains that the first embedding batch is being prepared", () => {
  const { controls, elements } = loadControls();

  controls.render([{
    job_id: "job-1", status: "running", processed_messages: 0,
    total_messages: 84188, stored_chunks: 0,
  }], 84188);

  const jobRow = elements.get("#indexing-jobs").children[0];
  assert.equal(jobRow.children[0].children[0].textContent, "Připravuji index");
  assert.match(jobRow.children[1].textContent, /první embedding dávku/);
});

test("indexing progress identifies its source conversation", () => {
  const { controls, elements } = loadControls();

  controls.render([{
    job_id: "job-1", status: "running", processed_messages: 10,
    total_messages: 84, stored_chunks: 2, source_type: "discord",
    source_container_label: "Workspace", source_conversation_label: "general",
  }], 84);

  const phaseText = elements.get("#indexing-jobs").children[0].children[1].textContent;
  assert.match(phaseText, /Discord/);
  assert.match(phaseText, /Workspace/);
  assert.match(phaseText, /general/);
  assert.match(controls.sourceLabel({
    source_type: "maintenance", job_type: "sync", embedding_index_name: "Primary",
  }), /Sync indexu.*Primary/);
});

test("queued maintenance explains that it follows the running index job", () => {
  const { controls, elements } = loadControls();

  controls.render([{
    job_id: "queued", status: "queued", processed_messages: 0,
    total_messages: 24, stored_chunks: 0, source_type: "maintenance",
    job_type: "incremental", embedding_index_id: "primary",
    embedding_index_name: "Default OpenAI index",
  }, {
    job_id: "running", status: "running", processed_messages: 10,
    total_messages: 84, stored_chunks: 2, embedding_index_id: "primary",
  }], 24);

  const rows = elements.get("#indexing-jobs").children;
  assert.equal(rows[0].children[0].children[0].textContent, "Indexuji · 11 %");
  assert.equal(elements.get("#index-pending-button").textContent,
    "Indexování běží · ve frontě: 1");
  const phase = rows[1].children[1].textContent;
  assert.match(phase, /Navazující indexace/);
  assert.match(phase, /24 zpráv.*dokončení.*spustí automaticky/);
  assert.doesNotMatch(phase, /Doplnění indexu/);
});

test("the live panel renders only queued and running jobs", () => {
  const { controls, elements } = loadControls();

  controls.render([{
    job_id: "running", status: "running", processed_messages: 57,
    total_messages: 100, stored_chunks: 12, embedding_index_id: "primary",
  }, {
    job_id: "failure", status: "failed", processed_messages: 0,
    total_messages: 100, stored_chunks: 0, embedding_index_id: "primary",
    last_error: "API key for provider 'openai' is missing.",
  }, {
    job_id: "cancelled", status: "cancelled", processed_messages: 0,
    total_messages: 100, stored_chunks: 0, embedding_index_id: "primary",
  }, {
    job_id: "completed", status: "completed", processed_messages: 100,
    total_messages: 100, stored_chunks: 20, embedding_index_id: "primary",
  }], 43);

  const rows = elements.get("#indexing-jobs").children;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].children[0].children[0].textContent, "Indexuji · 57 %");
});

test("a terminal-only live panel reports that no active jobs remain", () => {
  const { controls, elements } = loadControls();

  controls.render([{
    job_id: "failure", status: "failed", processed_messages: 0,
    total_messages: 100, stored_chunks: 0, embedding_index_id: "primary",
    last_error: "API key for provider 'openai' is missing.",
  }], 100);

  const label = elements.get("#indexing-jobs").children[0];
  assert.equal(label.textContent, "Žádné aktivní indexovací úlohy");
});

test("settings history keeps terminal jobs and can retry a cancelled job", async () => {
  const container = new FakeElement();
  const retried = [];
  const pushed = [];
  let refreshCount = 0;
  const context = {
    window: {
      chatContext: {
        retryIndexingJob: async (jobId) => {
          retried.push(jobId);
          return { job_id: jobId, status: "queued" };
        },
      },
      indexingControls: { applyProgress: (job) => pushed.push(job) },
    },
    document: {
      createElement: () => new FakeElement(),
      querySelector: () => container,
    },
  };
  vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, "..", "renderer", "indexing-job-history-ui.js"), "utf8",
  ), context);
  context.window.indexingJobHistoryUi.bind({
    refreshSettings: async () => { refreshCount += 1; }, showToast: () => {},
  });
  context.window.indexingJobHistoryUi.render([{
    job_id: "running", status: "running",
  }, {
    job_id: "cancelled", status: "cancelled", processed_messages: 12,
    total_messages: 100, stored_chunks: 3, embedding_index_name: "Primary",
  }]);

  assert.equal(container.children.length, 1);
  assert.match(container.children[0].children[0].textContent, /Primary.*Zrušeno/);
  await container.children[0].children[2].listeners.click();
  assert.deepEqual(retried, ["cancelled"]);
  assert.deepEqual(JSON.parse(JSON.stringify(pushed)), [{
    job_id: "cancelled", status: "queued",
  }]);
  assert.equal(refreshCount, 1);
});

test("pushed progress updates the rendered row without an overview reload", () => {
  const { controls, elements } = loadControls();
  controls.bind({ refreshOverview: async () => {}, showToast: () => {} });
  controls.render([{
    job_id: "job-1", status: "running", processed_messages: 10,
    total_messages: 100, stored_chunks: 2,
  }], 90);

  controls.applyProgress({
    job_id: "job-1", status: "running", processed_messages: 57,
    total_messages: 100, stored_chunks: 12,
  });

  const row = elements.get("#indexing-jobs").children[0];
  assert.equal(row.children[0].children[0].textContent, "Indexuji · 57 %");
  assert.equal(row.children[0].children[1].textContent, "12 chunků");
});

test("polling refreshes every active job when a queued row is first", async () => {
  const requested = [];
  const responses = {
    queued: {
      job_id: "queued", status: "queued", processed_messages: 0,
      total_messages: 24, stored_chunks: 0,
    },
    running: {
      job_id: "running", status: "running", processed_messages: 50,
      total_messages: 100, stored_chunks: 15,
    },
  };
  const { controls, elements, scheduledCallbacks } = loadControls((jobId) => {
    requested.push(jobId);
    return responses[jobId];
  });
  controls.bind({ refreshOverview: async () => {}, showToast: () => {} });
  controls.render([responses.queued, {
    ...responses.running, processed_messages: 10, stored_chunks: 2,
  }], 24);

  await scheduledCallbacks[0]();

  assert.deepEqual(requested, ["queued", "running"]);
  const runningRow = elements.get("#indexing-jobs").children[0];
  assert.equal(runningRow.children[0].children[0].textContent, "Indexuji · 50 %");
  assert.equal(runningRow.children[0].children[1].textContent, "15 chunků");
});

test("active job polling refreshes the overview after completion", async () => {
  const completedJob = {
    job_id: "job-1", status: "completed", processed_messages: 84,
    total_messages: 84, stored_chunks: 7,
  };
  const { controls, scheduledCallbacks } = loadControls(completedJob);
  let refreshCount = 0;
  controls.bind({
    refreshOverview: async () => { refreshCount += 1; },
    showToast: () => {},
  });
  controls.render([{
    job_id: "job-1", status: "running", processed_messages: 10,
    total_messages: 84, stored_chunks: 2,
  }], 84);

  assert.equal(scheduledCallbacks.length, 1);
  await scheduledCallbacks[0]();

  assert.equal(refreshCount, 1);
});

test("renderer routes pushed indexing events into the live job controls", () => {
  const appSource = fs.readFileSync(
    path.join(__dirname, "..", "renderer", "app.js"), "utf8",
  );

  assert.match(appSource, /indexingControls\.applyProgress\(job\)/);
  assert.match(appSource, /onIndexingProgress\(renderIndexingProgress\)/);
});
