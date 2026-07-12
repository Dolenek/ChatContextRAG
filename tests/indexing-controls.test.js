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
    this.classList = { contains: () => false };
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  addEventListener() {}

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
      chatContext: { getIndexingJob: async () => jobResponse },
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
