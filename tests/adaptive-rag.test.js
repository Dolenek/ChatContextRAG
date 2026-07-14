const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { ProviderStore } = require("../electron/provider-store");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("retrieval selector defaults from model capability and preserves restored mode", () => {
  const adaptiveOption = { disabled: false };
  const selector = {
    value: "", title: "", listeners: {},
    addEventListener(name, callback) { this.listeners[name] = callback; },
    querySelector: () => adaptiveOption,
  };
  const context = {
    document: { querySelector: () => selector },
    window: {},
  };
  vm.runInNewContext(read("renderer/retrieval-mode-selector.js"), context);
  const retrieval = context.window.retrievalModeSelector;

  retrieval.applyModel({ supportsArchiveTools: true, evidenceCharacterLimit: 48000 });
  assert.deepEqual(JSON.parse(JSON.stringify(retrieval.getSelection())), {
    retrievalMode: "adaptive", evidenceCharacterLimit: 48000,
  });

  retrieval.applyModel({ supportsArchiveTools: false, evidenceCharacterLimit: 24000 });
  assert.equal(selector.value, "deterministic");
  assert.equal(adaptiveOption.disabled, true);
  assert.equal(retrieval.restore("adaptive", 4000), true);
  assert.deepEqual(JSON.parse(JSON.stringify(retrieval.getSelection())), {
    retrievalMode: "adaptive", evidenceCharacterLimit: 4000,
  });
  retrieval.release();
  assert.equal(selector.value, "deterministic");
});

test("model capability migration and evidence validation are provider-aware", () => {
  const directory = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "adaptive-models-"));
  const store = new ProviderStore(directory, {});
  try {
    store.saveChatModel({ providerId: "openai", model: "gpt-test" });
    store.saveChatModel({ providerId: "local", model: "local-test" });
    const models = store.listChatModels();
    assert.equal(models[0].supports_archive_tools, true);
    assert.equal(models[1].supports_archive_tools, false);
    assert.equal(models[0].evidence_character_limit, 24000);
    assert.throws(() => store.saveChatModel({
      providerId: "local", model: "bad-limit", evidenceCharacterLimit: 3999,
    }), /4000.*48000/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("adaptive mode is wired through both bridges with bounded proxy timeouts", () => {
  const html = read("renderer/index.html");
  assert.match(html, /id="retrieval-mode-select"/);
  assert.match(html, /retrieval-mode-selector\.js/);
  assert.match(read("electron/preload.js"), /evidence_character_limit/);
  assert.match(read("renderer/runtime-bridge.js"), /retrieval_mode/);
  assert.match(read("electron/chat-ipc.js"), /timeoutMs: 130_000/);
  assert.match(read("web/api-router.js"), /timeoutMs: 130_000/);
  assert.match(read("renderer/chat-controller.js"), /askDatabaseStreaming/);
  assert.match(read("renderer/chat-sources.js"), /evidence_origin === "context"/);
});
