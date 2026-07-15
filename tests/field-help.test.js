const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("model help uses dotted accessible tooltip triggers", () => {
  const html = read("renderer/index.html");
  const modelUi = read("renderer/chat-model-settings-ui.js");
  const styles = read("renderer/settings-overlay.css");

  assert.match(html, /class="field-help-term"[^>]+aria-describedby="chat-model-reasoning-help"/);
  assert.match(html, /id="chat-model-reasoning-help" class="sr-only" role="tooltip"/);
  assert.match(html, /id="chat-model-reasoning-effort" aria-describedby="chat-model-reasoning-help"/);
  assert.doesNotMatch(html, /class="settings-form-hint"/);
  assert.match(modelUi, /createHelpLabel\(\s*archiveTools, "Archivní tools"/);
  assert.match(modelUi, /createHelpLabel\(\s*evidenceLimit, "Limit evidence \(znaky\)"/);
  assert.match(modelUi, /control\.setAttribute\("aria-describedby", descriptionId\)/);
  assert.match(modelUi, /accessibleDescription\.setAttribute\("role", "tooltip"\)/);
  assert.match(styles, /\.field-help-term[^}]+text-decoration: underline dotted/);
  assert.match(styles, /\.field-help-term:hover::after, \.field-help-term:focus::after/);
});

test("tooltip opens by tap and closes by second tap, outside click, or Escape", () => {
  const listeners = {};
  const document = {
    activeElement: null,
    addEventListener: (name, callback) => { listeners[name] = callback; },
    querySelectorAll: () => [term],
  };
  const term = {
    closest: (selector) => selector === ".field-help-term" ? term : null,
    focus: () => { document.activeElement = term; },
    blur: () => { document.activeElement = null; },
  };
  const outside = { closest: () => null };
  vm.runInNewContext(read("renderer/field-help.js"), { document });

  listeners.pointerdown({ target: term });
  listeners.click({ target: term, preventDefault: () => {} });
  assert.equal(document.activeElement, term);
  listeners.pointerdown({ target: term });
  listeners.click({ target: term, preventDefault: () => {} });
  assert.equal(document.activeElement, null);
  term.focus();
  listeners.click({ target: outside, preventDefault: () => {} });
  assert.equal(document.activeElement, null);
  term.focus();
  listeners.keydown({ key: "Escape" });
  assert.equal(document.activeElement, null);
});

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}
