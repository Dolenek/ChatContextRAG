const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const projectRoot = path.resolve(__dirname, "..");

test("chat renders safe grounded source cards with match and chunk controls", () => {
  const sourceRenderer = fs.readFileSync(
    path.join(projectRoot, "renderer", "chat-sources.js"), "utf8",
  );
  const chatController = fs.readFileSync(
    path.join(projectRoot, "renderer", "chat-controller.js"), "utf8",
  );

  assert.match(chatController, /response\.sources/);
  assert.match(sourceRenderer, /Použitý zdroj/);
  assert.match(sourceRenderer, /authorAccent/);
  assert.match(sourceRenderer, /Shoda \$\{relative\}/);
  assert.match(sourceRenderer, /Raw RRF/);
  assert.match(sourceRenderer, /Zobrazit chunk/);
  assert.match(sourceRenderer, /chunk\.content/);
  assert.doesNotMatch(sourceRenderer, /openDiscordSource|Otevřít v Discordu/);
  assert.match(sourceRenderer, /\.textContent\s*=/);
  assert.doesNotMatch(sourceRenderer, /innerHTML\s*=/);
});

test("source score tooltip and chunk expansion use safe text", () => {
  const document = {
    createElement: (tag) => new FakeElement(tag),
    createElementNS: (_namespace, tag) => new FakeElement(tag),
  };
  const context = { document, window: {} };
  vm.runInNewContext(readSourceRenderer(), context);
  const source = {
    author: "Ada", content: "Message", source_type: "discord", channel: "general",
    similarity_score: 0.02841, match_score: 0.87, score_kind: "rrf",
    chunk: { content: "<img src=x onerror=alert(1)>\nnext", origin: "retrieved" },
  };

  const card = context.window.chatSources.createChatSourceCard(source, { index: 1 });
  const match = findClass(card, "source-match-score");
  const toggle = findClass(card, "source-chunk-toggle");
  const chunk = findClass(card, "source-chunk");
  assert.equal(match.textContent, "Shoda 0,87");
  assert.match(match.title, /Raw RRF: 0,02841/);
  assert.equal(chunk.children[1].textContent, "<img src=x onerror=alert(1)>\nnext");
  toggle.listeners.click();
  assert.equal(chunk.hidden, false);
  assert.equal(toggle.attributes["aria-expanded"], "true");
});

class FakeElement {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this.classList = { add: (value) => { this.className = value; } };
  }
  append(...children) { this.children.push(...children); }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
}

function findClass(element, className) {
  if (element.className?.split(" ").includes(className)) return element;
  for (const child of element.children || []) {
    if (typeof child !== "string") {
      const match = findClass(child, className);
      if (match) return match;
    }
  }
  return null;
}

function readSourceRenderer() {
  return fs.readFileSync(path.join(projectRoot, "renderer", "chat-sources.js"), "utf8");
}
