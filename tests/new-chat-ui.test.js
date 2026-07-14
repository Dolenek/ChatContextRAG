const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");

test("composer uses multiline keyboard semantics without advertising attachments", () => {
  const html = read("renderer/index.html");
  const styles = read("renderer/chat.css");
  const view = read("renderer/conversation-view.js");

  assert.match(html, /<textarea id="question-input"/);
  assert.match(html, /class="composer-send"/);
  assert.match(html, /class="model-trigger-prefix">Model:/);
  assert.doesNotMatch(html, /paperclip|attachment|příloh/i);
  assert.match(view, /event\.key !== "Enter" \|\| event\.shiftKey \|\| event\.isComposing/);
  assert.match(view, /textarea\.form\.requestSubmit\(\)/);
  assert.match(view, /Math\.min\(textarea\.scrollHeight, 180\)/);
  assert.match(styles, /min-height: 132px/);
});

test("Discord and WhatsApp use local SVG sprite icons", () => {
  const html = read("renderer/index.html");
  const sources = read("renderer/chat-sources.js");

  assert.match(html, /id="icon-discord"/);
  assert.match(html, /id="icon-whatsapp"/);
  assert.match(html, /use href="#icon-discord"/);
  assert.match(html, /use href="#icon-whatsapp"/);
  assert.match(sources, /createBrandIcon/);
  assert.match(sources, /use\.setAttribute\("href", `#icon-\$\{iconName\}`\)/);
});

test("conversation view displays persisted timestamps and source recall controls safely", () => {
  const view = read("renderer/conversation-view.js");

  assert.match(view, /message\.created_at/);
  assert.match(view, /Odpověď podložena \$\{sources\.length\} zprávami/);
  assert.match(view, /window\.contextPanel\.showSources\(sources\)/);
  assert.match(view, /bubble\.textContent = text/);
  assert.doesNotMatch(view, /innerHTML\s*=/);
});

test("complete context is an accessible modal with full source rendering", () => {
  const html = read("renderer/index.html");
  const modal = read("renderer/context-detail-modal.js");

  assert.match(html, /id="context-detail-dialog"[^>]+role="dialog"[^>]+aria-modal="true"/);
  assert.match(modal, /mode: "detail"/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /event\.key === "Tab"/);
  assert.match(modal, /if \(event\.target === overlay\) close\(\)/);
  assert.match(modal, /appLayout\.inert = true/);
  assert.match(modal, /focusReturnTarget\?\.focus\?\.\(\)/);
});

test("thinking and restored-context feedback have accessible lifecycles", () => {
  const controller = read("renderer/chat-controller.js");
  const view = read("renderer/conversation-view.js");
  const panel = read("renderer/context-panel.js");
  const chatStyles = read("renderer/chat.css");

  assert.match(controller, /appendThinking\(\)/);
  assert.match(controller, /replaceThinking/);
  assert.match(controller, /removeThinking/);
  assert.match(controller, /markFailed/);
  assert.match(view, /Přemýšlím…/);
  assert.match(view, /role", "status"/);
  assert.match(chatStyles, /thinking-pulse/);
  assert.match(chatStyles, /prefers-reduced-motion: reduce/);
  assert.match(panel, /Použitý kontext aktualizován/);
  assert.match(panel, /context-refreshed/);
});

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}
