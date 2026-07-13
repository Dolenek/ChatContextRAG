const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");
const sectionNames = [
  "providers", "chat-models", "embedding-indexes", "indexing-history", "workspace",
];

class FakeClassList {
  constructor(initial = []) { this.values = new Set(initial); }
  add(value) { this.values.add(value); }
  remove(value) { this.values.delete(value); }
  contains(value) { return this.values.has(value); }
  toggle(value, force) {
    const enabled = force === undefined ? !this.contains(value) : force;
    enabled ? this.add(value) : this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(document, classes = []) {
    this.document = document;
    this.classList = new FakeClassList(classes);
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.children = [];
    this.disabled = false;
    this.inert = false;
  }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  append(...children) { children.forEach((child) => { child.parent = this; }); this.children.push(...children); }
  contains(element) { return element === this || this.children.some((child) => child.contains(element)); }
  focus() { this.document.activeElement = this; }
  getClientRects() { return this.closest(".hidden") ? [] : [{}]; }
  querySelectorAll() { return this.focusableElements || []; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  closest(selector) {
    if (selector === ".hidden" && this.classList.contains("hidden")) return this;
    return this.parent?.closest(selector) || null;
  }
}

test("settings overlay selects sections and closes through every supported path", () => {
  const fixture = createOverlayFixture();
  let closeCount = 0;
  fixture.controller.bind({ onClose: () => { closeCount += 1; } });
  fixture.document.activeElement = fixture.settingsButton;

  fixture.controller.open();
  assert.equal(fixture.controller.isOpen(), true);
  assert.equal(fixture.appLayout.inert, true);
  assert.equal(fixture.closeButton, fixture.document.activeElement);
  assert.equal(fixture.navigationButtons[0].attributes["aria-current"], "page");

  fixture.navigationButtons[1].listeners.click();
  assert.equal(fixture.sectionPanels[0].classList.contains("hidden"), true);
  assert.equal(fixture.sectionPanels[1].classList.contains("hidden"), false);

  fixture.overlay.listeners.click({ target: fixture.dialog });
  assert.equal(fixture.controller.isOpen(), true);
  fixture.overlay.listeners.click({ target: fixture.overlay });
  assert.equal(fixture.controller.isOpen(), false);
  assert.equal(closeCount, 1);
  assert.equal(fixture.appLayout.inert, false);
  assert.equal(fixture.document.activeElement, fixture.settingsButton);
  assert.equal(fixture.sectionPanels[0].classList.contains("hidden"), false);

  fixture.controller.open();
  fixture.document.listeners.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(fixture.controller.isOpen(), false);
  fixture.controller.open();
  fixture.closeButton.listeners.click();
  assert.equal(fixture.controller.isOpen(), false);
  assert.equal(closeCount, 3);
});

test("settings overlay traps keyboard focus and declares responsive web behavior", () => {
  const fixture = createOverlayFixture();
  fixture.controller.bind();
  fixture.controller.open();
  fixture.document.activeElement = fixture.navigationButtons.at(-1);
  let prevented = false;
  fixture.document.listeners.keydown({
    key: "Tab", shiftKey: false, preventDefault() { prevented = true; },
  });

  assert.equal(prevented, true);
  assert.equal(fixture.document.activeElement, fixture.closeButton);
  const css = read("renderer/settings-overlay.css");
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /web-runtime .*data-settings-section="workspace"/);
});

function createOverlayFixture() {
  const document = { body: null, activeElement: null, listeners: {} };
  document.body = new FakeElement(document);
  document.addEventListener = (name, callback) => { document.listeners[name] = callback; };
  const overlay = new FakeElement(document, ["hidden"]);
  const dialog = new FakeElement(document);
  const appLayout = new FakeElement(document);
  const settingsButton = new FakeElement(document);
  const closeButton = new FakeElement(document);
  const navigationButtons = sectionNames.map((name) => {
    const button = new FakeElement(document); button.dataset.settingsSection = name; return button;
  });
  const sectionPanels = sectionNames.map((name, index) => {
    const panel = new FakeElement(document, index ? ["hidden"] : []);
    panel.dataset.settingsPanel = name;
    return panel;
  });
  dialog.append(closeButton, ...navigationButtons, ...sectionPanels);
  overlay.append(dialog);
  dialog.focusableElements = [closeButton, ...navigationButtons];
  const elements = new Map([
    ["#settings-overlay", overlay], ["#settings-dialog", dialog], [".app-layout", appLayout],
    ["#open-settings-button", settingsButton], ["#close-settings-button", closeButton],
  ]);
  document.querySelector = (selector) => elements.get(selector);
  document.querySelectorAll = (selector) => selector === "[data-settings-section]"
    ? navigationButtons : sectionPanels;
  const context = { document, window: {} };
  vm.runInNewContext(read("renderer/settings-overlay.js"), context);
  return {
    controller: context.window.settingsOverlay, document, overlay, dialog, appLayout,
    settingsButton, closeButton, navigationButtons, sectionPanels,
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
