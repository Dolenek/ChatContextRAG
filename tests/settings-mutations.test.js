const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("provider metadata projects immediately and restores the exact form on rollback", () => {
  const fields = providerFields();
  const originalState = {
    providers: [{
      provider_id: "custom", name: "Original", base_url: "https://old.test/v1",
      chat_api: "responses", has_api_key: true,
    }],
  };
  let state = originalState;
  const context = {
    document: { querySelector: (selector) => fields.get(selector) },
    window: {}, Date,
  };
  run(context, "renderer/settings-provider-projection.js");
  const projection = context.window.settingsProviderProjection;
  projection.bind({
    getState: () => state,
    updateSettings: (project) => { const previous = state; state = project(state); return previous; },
    resetForm: () => { fields.get("#provider-form").resetCalled = true; },
  });
  const input = projection.readForm();

  const snapshot = projection.projectPending(input);
  assert.equal(state.providers[0].name, "Renamed");
  assert.equal(state.providers[0].has_api_key, true);
  assert.equal(state.providers[0]._pending, true);
  projection.rollback(snapshot);
  assert.equal(state, originalState);
  assert.equal(fields.get("#provider-api-key").value, "replacement-secret");
  assert.equal(fields.get("#provider-name").focused, true);
});

test("destructive provider action stays pending until confirmation", async () => {
  const deletion = deferred();
  const button = fakeButton("Smazat");
  const messages = [];
  let invalidations = 0;
  let state = {
    providers: [{ provider_id: "first" }, { provider_id: "second" }],
  };
  const context = {
    window: {
      chatContext: { deleteProvider: () => deletion.promise },
      workspaceCache: { invalidate: () => { invalidations += 1; } },
      overviewController: { markDatabaseChanged: () => {} },
    },
  };
  run(context, "renderer/interaction-coordinator.js");
  run(context, "renderer/settings-mutation-ui.js");
  run(context, "renderer/settings-entity-actions.js");
  context.window.settingsMutationUi.bind({
    reconcile: async () => { throw new Error("refresh failed"); },
    showToast: (message) => messages.push(message),
  });
  context.window.settingsEntityActions.bind({
    updateSettings: (project) => { const previous = state; state = project(state); return previous; },
  });

  const pending = context.window.settingsEntityActions.removeProvider("first", button);
  assert.deepEqual(state.providers.map((provider) => provider.provider_id), ["first", "second"]);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Mažu…");
  deletion.resolve({ deleted: true });
  await pending;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(state.providers.map((provider) => provider.provider_id), ["second"]);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Smazat");
  assert.equal(invalidations, 1);
  assert.ok(messages.some((message) => message.includes("refresh failed")));
});

function providerFields() {
  const fields = new Map([
    ["#provider-id", fakeField("custom")], ["#provider-name", fakeField("Renamed")],
    ["#provider-base-url", fakeField("https://new.test/v1")],
    ["#provider-api-key", fakeField("replacement-secret")],
    ["#provider-chat-api", fakeField("chat_completions")],
    ["#provider-form", { resetCalled: false }],
  ]);
  return fields;
}

function fakeField(value) {
  return { value, focus() { this.focused = true; } };
}

function fakeButton(textContent) {
  const attributes = new Map();
  return {
    textContent, disabled: false,
    classList: { add: () => {}, remove: () => {} },
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: (name) => attributes.get(name) ?? null,
    removeAttribute: (name) => attributes.delete(name),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function run(context, relativePath) {
  vm.runInNewContext(fs.readFileSync(
    path.join(__dirname, "..", relativePath), "utf8",
  ), context);
}
