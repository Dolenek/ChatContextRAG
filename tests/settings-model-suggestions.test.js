const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("older OpenAI suggestions cannot replace the latest custom provider", async () => {
  const openAiRequest = deferred();
  const customRequest = deferred();
  const fixture = suggestionFixture((providerId) => (
    providerId === "openai" ? openAiRequest.promise : customRequest.promise
  ));
  const { elements, suggestions } = fixture;

  elements.chatProvider.value = "openai";
  const openAiLoad = suggestions.loadChat();
  assert.equal(elements.chatInput.attributes.get("aria-busy"), "true");
  elements.chatProvider.value = "custom";
  const customLoad = suggestions.loadChat();
  assert.deepEqual(elements.chatOptions.children, []);

  customRequest.resolve({ models: ["custom-chat"] });
  assert.equal((await customLoad).status, "applied");
  openAiRequest.resolve({ models: ["gpt-default"] });
  assert.equal((await openAiLoad).status, "stale");
  assert.deepEqual(elements.chatOptions.children.map((option) => option.value), [
    "custom-chat",
  ]);
  assert.equal(elements.chatInput.attributes.has("aria-busy"), false);
});

test("embedding suggestions clear immediately and use their own latest key", async () => {
  const request = deferred();
  const { elements, suggestions } = suggestionFixture(() => request.promise);
  elements.embeddingProvider.value = "local";
  elements.embeddingOptions.children = [{ value: "stale" }];

  const load = suggestions.loadEmbedding();
  assert.deepEqual(elements.embeddingOptions.children, []);
  assert.equal(elements.embeddingInput.attributes.get("aria-busy"), "true");
  request.resolve({ models: ["embed-local"] });
  await load;
  assert.deepEqual(elements.embeddingOptions.children.map((option) => option.value), [
    "embed-local",
  ]);
});

function suggestionFixture(listProviderModels) {
  const elements = {
    chatProvider: fakeElement(), chatInput: fakeElement(), chatOptions: fakeElement(),
    embeddingProvider: fakeElement(), embeddingInput: fakeElement(),
    embeddingOptions: fakeElement(),
  };
  const selectors = new Map([
    ["#chat-model-provider-select", elements.chatProvider],
    ["#chat-model-input", elements.chatInput], ["#chat-model-options", elements.chatOptions],
    ["#embedding-provider-select", elements.embeddingProvider],
    ["#embedding-model-input", elements.embeddingInput],
    ["#embedding-model-options", elements.embeddingOptions],
  ]);
  const context = {
    document: {
      querySelector: (selector) => selectors.get(selector),
      createElement: () => fakeElement(),
    },
    window: { chatContext: { listProviderModels } },
  };
  run(context, "renderer/interaction-coordinator.js");
  run(context, "renderer/settings-model-suggestions.js");
  return { elements, suggestions: context.window.settingsModelSuggestions };
}

function fakeElement() {
  return {
    value: "", children: [], attributes: new Map(),
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function run(context, relativePath) {
  vm.runInNewContext(read(relativePath), context);
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}
