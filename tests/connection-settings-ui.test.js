const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const controllerSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "connection-settings-ui.js"), "utf8",
);

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor(initialClasses = []) {
    Object.assign(this, {
      attributes: {}, checked: false, classList: new FakeClassList(initialClasses), disabled: false,
      listeners: {}, placeholder: "", textContent: "", value: "",
    });
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

test("local target hides remote fields and switching to Remote reveals them", async () => {
  const fixture = createFixture({ mode: "local", hasToken: false });
  await fixture.controller.refresh();

  assert.equal(fixture.remoteFields.classList.contains("hidden"), true);
  assert.equal(fixture.url.disabled, true);
  assert.equal(fixture.token.disabled, true);
  assert.equal(fixture.testButton.classList.contains("hidden"), true);
  assert.equal(fixture.saveButton.textContent, "Použít lokální workspace a restartovat");
  assert.equal(fixture.status.textContent, "Aktivní lokální workspace na tomto počítači");

  fixture.mode.value = "remote";
  fixture.mode.listeners.change();
  assert.equal(fixture.remoteFields.classList.contains("hidden"), false);
  assert.equal(fixture.url.disabled, false);
  assert.equal(fixture.token.disabled, false);
  assert.equal(fixture.testButton.classList.contains("hidden"), false);
  assert.equal(fixture.saveButton.textContent, "Připojit a restartovat");
});

test("remote target shows its server and preserves the stored token placeholder", async () => {
  const target = {
    mode: "remote", baseUrl: "https://server.example", hasToken: true,
    insecureHttpAcknowledged: false,
  };
  const fixture = createFixture(target);
  await fixture.controller.refresh();

  assert.equal(fixture.url.value, target.baseUrl);
  assert.equal(fixture.token.value, "");
  assert.match(fixture.token.placeholder, /zachová/);
  assert.equal(fixture.remoteFields.attributes["aria-hidden"], "false");
  assert.equal(fixture.status.textContent, `Aktivní vzdálený Chat Context server: ${target.baseUrl}`);
  assert.deepEqual(fixture.archiveRefreshes, [target]);
});

test("failed remote save reports the error without projecting another target", async () => {
  const fixture = createFixture({
    mode: "remote", baseUrl: "https://saved.example", hasToken: true,
    insecureHttpAcknowledged: false,
  }, new Error("Server není dostupný"));
  await fixture.controller.refresh();
  fixture.url.value = "https://offline.example";
  fixture.token.value = "replacement-token";

  await fixture.form.listeners.submit({ preventDefault() {}, submitter: fixture.saveButton });

  assert.equal(fixture.savedInputs.length, 1);
  assert.equal(fixture.savedInputs[0].baseUrl, "https://offline.example");
  assert.equal(fixture.mode.value, "remote");
  assert.equal(fixture.status.textContent,
    "Aktivní vzdálený Chat Context server: https://saved.example");
  assert.deepEqual(fixture.toasts, [["Server není dostupný", true]]);
});

function createFixture(target, saveError = null) {
  const namedElements = createElements();
  const archiveRefreshes = [];
  const savedInputs = [];
  const toasts = [];
  const document = { querySelector: (selector) => namedElements.get(selector) };
  const window = {
    archiveMigrationUi: {
      connectionSelectionChanged() {},
      refresh: async (value) => archiveRefreshes.push(value),
    },
    chatContext: {
      getConnectionTarget: async () => target,
      saveConnectionTarget: async (input) => {
        savedInputs.push(input);
        if (saveError) throw saveError;
      },
      testConnectionTarget: async () => ({}),
    },
    connectionSecurity: {
      normalizedOrigin: (value) => value || null,
      requiresInsecureHttpAcknowledgement: () => false,
    },
    interactionCoordinator: {
      runMutation: async ({ execute, commit }) => { await execute(); commit(); },
    },
  };
  vm.runInNewContext(controllerSource, { document, window });
  window.connectionSettingsUi.bind({ showToast: (...values) => toasts.push(values) });
  return fixtureResult(namedElements, window.connectionSettingsUi, {
    archiveRefreshes, savedInputs, toasts,
  });
}

function createElements() {
  return new Map([
    ["#connection-mode", new FakeElement()],
    ["#connection-url", new FakeElement()],
    ["#connection-token", new FakeElement()],
    ["#insecure-http-acknowledged", new FakeElement()],
    ["#connection-form", new FakeElement()],
    ["#test-connection-button", new FakeElement(["hidden"])],
    ["#connection-status", new FakeElement()],
    ["#remote-connection-fields", new FakeElement(["hidden"])],
    ["#save-connection-button", new FakeElement()],
    ["#insecure-http-warning", new FakeElement(["hidden"])],
  ]);
}

function fixtureResult(elements, controller, state) {
  const selectors = {
    form: "#connection-form", mode: "#connection-mode", remoteFields: "#remote-connection-fields",
    saveButton: "#save-connection-button", status: "#connection-status",
    testButton: "#test-connection-button", token: "#connection-token", url: "#connection-url",
  };
  return Object.fromEntries([
    ["controller", controller], ...Object.entries(state),
    ...Object.entries(selectors).map(([name, selector]) => [name, elements.get(selector)]),
  ]);
}
