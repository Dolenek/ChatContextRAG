const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const controllerSource = fs.readFileSync(
  path.join(__dirname, "..", "renderer", "runtime-capabilities-ui.js"), "utf8",
);

class FakeClassList {
  constructor() { this.values = new Set(["hidden"]); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    if (force) this.values.add(value);
    else this.values.delete(value);
  }
}

class FakeElement {
  constructor() {
    this.attributes = { "aria-hidden": "true" };
    this.classList = new FakeClassList();
  }
  removeAttribute(name) { delete this.attributes[name]; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

test("Electron Local and Remote expose desktop target settings and the local scanner", () => {
  for (const mode of ["electron-local", "electron-remote"]) {
    const fixture = createFixture({ mode, embeddedDiscord: true });
    fixture.controller.apply({ mode, embeddedDiscord: true });

    assert.equal(fixture.connection.classList.contains("hidden"), false);
    assert.equal(fixture.scannerButton.classList.contains("hidden"), false);
    assert.equal(fixture.scannerPanel.classList.contains("hidden"), false);
    assert.equal(fixture.document.body.dataset.runtimeMode, mode);
  }
});

test("Web keeps data-target settings and local scanner hidden", async () => {
  const fixture = createFixture({ mode: "web", embeddedDiscord: false });
  await fixture.controller.refresh();

  for (const element of fixture.runtimeElements) {
    assert.equal(element.classList.contains("hidden"), true);
    assert.equal(element.attributes["aria-hidden"], "true");
  }
  assert.equal(fixture.document.body.dataset.runtimeMode, "web");
});

test("desktop capability can independently disable the local scanner", () => {
  const fixture = createFixture({ mode: "electron-local", embeddedDiscord: false });
  fixture.controller.apply({ mode: "electron-local", embeddedDiscord: false });

  assert.equal(fixture.connection.classList.contains("hidden"), false);
  assert.equal(fixture.scannerButton.classList.contains("hidden"), true);
  assert.equal(fixture.scannerPanel.classList.contains("hidden"), true);
});

test("capabilities are requested as soon as their controller loads", async () => {
  const fixture = createFixture({ mode: "electron-local", embeddedDiscord: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fixture.capabilityRequests(), 1);
  assert.equal(fixture.connection.classList.contains("hidden"), false);
});

function createFixture(capabilities) {
  let requestCount = 0;
  const connection = new FakeElement();
  const scannerButton = new FakeElement();
  const scannerPanel = new FakeElement();
  const elements = new Map([
    ["#connection-settings-card", connection],
    ["#open-discord-button", scannerButton],
    ["#discord-drawer-panel", scannerPanel],
  ]);
  const document = {
    body: { dataset: {} },
    querySelector: (selector) => elements.get(selector),
  };
  const context = {
    document,
    Set,
    window: { chatContext: { getRuntimeCapabilities: async () => {
      requestCount += 1;
      return capabilities;
    } } },
  };
  vm.runInNewContext(controllerSource, context);
  return {
    capabilityRequests: () => requestCount,
    connection, controller: context.window.runtimeCapabilitiesUi, document,
    runtimeElements: [connection, scannerButton, scannerPanel], scannerButton, scannerPanel,
  };
}
