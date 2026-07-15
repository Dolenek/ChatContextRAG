const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("mutation applies synchronously, blocks duplicates, and restores its control", async () => {
  const coordinator = loadCoordinator();
  const request = deferred();
  const events = [];
  const control = fakeControl("Save");
  const options = {
    key: "save", controls: [{ element: control, pendingText: "Saving…" }],
    apply: () => { events.push("apply"); return { exact: "snapshot" }; },
    execute: () => { events.push("execute"); return request.promise; },
    commit: (result, snapshot) => events.push(`${result}:${snapshot.exact}`),
  };

  const first = coordinator.runMutation(options);
  const duplicate = coordinator.runMutation({ ...options, apply: () => events.push("duplicate") });
  assert.deepEqual(events, ["apply", "execute"]);
  assert.equal(control.disabled, true);
  assert.equal(control.textContent, "Saving…");
  request.resolve("saved");
  assert.equal(await first, "saved");
  assert.equal(await duplicate, "saved");
  assert.deepEqual(events, ["apply", "execute", "saved:snapshot"]);
  assert.equal(control.disabled, false);
  assert.equal(control.textContent, "Save");
});

test("mutation rolls back the exact snapshot on request failure", async () => {
  const coordinator = loadCoordinator();
  const snapshot = { rows: ["original"], form: { model: "draft" } };
  let restored = null;

  await assert.rejects(coordinator.runMutation({
    key: "rollback", apply: () => snapshot,
    execute: async () => { throw new Error("save failed"); },
    rollback: (received) => { restored = received; },
  }), /save failed/);
  assert.equal(restored, snapshot);
});

test("latest request ignores stale results and stale errors", async () => {
  const coordinator = loadCoordinator();
  const older = deferred();
  const newer = deferred();
  const applied = [];
  const oldRun = coordinator.runLatest("models", () => older.promise, (value) => applied.push(value));
  const newRun = coordinator.runLatest("models", () => newer.promise, (value) => applied.push(value));

  newer.resolve("custom");
  assert.equal((await newRun).status, "applied");
  older.resolve("openai");
  assert.equal((await oldRun).status, "stale");
  assert.deepEqual(applied, ["custom"]);

  const staleFailure = deferred();
  const staleRun = coordinator.runLatest("errors", () => staleFailure.promise);
  const currentRun = coordinator.runLatest("errors", async () => "current");
  staleFailure.reject(new Error("obsolete"));
  assert.equal((await staleRun).status, "stale");
  assert.equal((await currentRun).status, "applied");
});

test("reconciliation failure is nonblocking and does not roll back a commit", async () => {
  const coordinator = loadCoordinator();
  const events = [];
  const result = await coordinator.runMutation({
    key: "reconcile", apply: () => "snapshot", execute: async () => "saved",
    commit: () => events.push("commit"), rollback: () => events.push("rollback"),
    reconcile: async () => { throw new Error("refresh failed"); },
    reconcileFailed: (error) => events.push(error.message),
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result, "saved");
  assert.deepEqual(events, ["commit", "refresh failed"]);
});

function loadCoordinator() {
  const context = { window: {} };
  vm.runInNewContext(read("renderer/interaction-coordinator.js"), context);
  return context.window.interactionCoordinator;
}

function fakeControl(textContent) {
  const attributes = new Map();
  return {
    disabled: false, textContent,
    classList: { add: () => {}, remove: () => {} },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}
