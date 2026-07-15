const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("chat model edit submits the original identity", async () => {
  const fixture = createChatModelFixture();
  const { elements, saved, resets } = fixture;

  await editFirstModel(elements);
  assert.equal(elements.modelId.value, "gpt-old");
  assert.equal(elements.saveButton.textContent, "Uložit změny");
  elements.modelId.value = "gpt-new";
  elements.effort.value = "medium";
  await submit(elements);

  assert.deepEqual(saved[0], {
    providerId: "openai", model: "gpt-new", label: "Old",
    reasoningEffort: "medium", originalProviderId: "openai", originalModel: "gpt-old",
    supportsArchiveTools: true, evidenceCharacterLimit: 24000,
  });
  assert.equal(fixture.released(), true);
  assert.deepEqual(resets, ["upraveným modelem"]);
});

test("environment fallback model keeps identity locked while editing", async () => {
  const fixture = createChatModelFixture({ managed: false });
  const { elements, saved } = fixture;

  await editFirstModel(elements);
  assert.equal(elements.provider.disabled, true);
  assert.equal(elements.modelId.disabled, true);
  elements.effort.value = "medium";
  await submit(elements);

  assert.deepEqual(saved[0], {
    providerId: "openai", model: "gpt-old", label: "Old", reasoningEffort: "medium",
    supportsArchiveTools: true, evidenceCharacterLimit: 24000,
  });
  assert.equal(elements.provider.disabled, false);
  assert.equal(elements.modelId.disabled, false);
});

test("new model is a noninteractive pending row until save confirmation", async () => {
  const saveRequest = deferred();
  const reconcileRequest = deferred();
  const fixture = createChatModelFixture({
    save: () => saveRequest.promise, reconcile: () => reconcileRequest.promise,
  });
  fillNewModel(fixture.elements, "gpt-fast");

  const savePromise = submit(fixture.elements);
  const pendingRow = fixture.elements.modelList.children[1];
  assert.equal(pendingRow.getAttribute("aria-busy"), "true");
  assert.equal(pendingRow.children[2].textContent, "Ukládám…");
  assert.equal(pendingRow.children.length, 3);

  saveRequest.resolve(savedModel({
    providerId: "openai", model: "gpt-fast", label: "Fast",
    reasoningEffort: "", supportsArchiveTools: true, evidenceCharacterLimit: 24000,
  }));
  await savePromise;
  const confirmedRow = fixture.elements.modelList.children[1];
  assert.equal(confirmedRow.getAttribute("aria-busy"), null);
  assert.equal(confirmedRow.children[2].textContent, "Upravit");
  assert.equal(confirmedRow.children[3].textContent, "Smazat");
  assert.equal(fixture.commits.length, 1);
});

test("failed model creation restores rows, form draft, and focus", async () => {
  const saveRequest = deferred();
  const fixture = createChatModelFixture({ save: () => saveRequest.promise });
  fillNewModel(fixture.elements, "gpt-broken");

  const savePromise = submit(fixture.elements);
  assert.equal(fixture.elements.modelList.children.length, 2);
  saveRequest.reject(new Error("save failed"));
  await savePromise;

  assert.equal(fixture.elements.modelList.children.length, 1);
  assert.equal(fixture.elements.modelId.value, "gpt-broken");
  assert.equal(fixture.elements.label.value, "Fast");
  assert.equal(fixture.elements.modelId.focused, true);
});

test("failed model edit restores the original row and editing draft", async () => {
  const saveRequest = deferred();
  const fixture = createChatModelFixture({ save: () => saveRequest.promise });
  await editFirstModel(fixture.elements);
  fixture.elements.modelId.value = "gpt-renamed";
  fixture.elements.effort.value = "medium";

  const savePromise = submit(fixture.elements);
  assert.equal(fixture.elements.modelList.children[0].children[2].textContent, "Ukládám…");
  saveRequest.reject(new Error("edit failed"));
  await savePromise;

  assert.equal(fixture.elements.modelList.children[0].children[0].textContent, "Old");
  assert.equal(fixture.elements.modelId.value, "gpt-renamed");
  assert.equal(fixture.elements.effort.value, "medium");
  assert.equal(fixture.elements.saveButton.textContent, "Uložit změny");
});

async function editFirstModel(elements) {
  await elements.modelList.children[0].children[2].listeners.click();
}

async function submit(elements) {
  await elements.form.listeners.submit({
    preventDefault: () => {}, submitter: elements.saveButton,
  });
}

function fillNewModel(elements, modelId) {
  elements.provider.value = "openai";
  elements.modelId.value = modelId;
  elements.label.value = "Fast";
  elements.effort.value = "";
}

function createChatModelFixture({ managed = true, save, reconcile } = {}) {
  const elements = chatModelElements();
  const saved = [];
  const resets = [];
  let released = false;
  const context = fixtureContext(elements, saved, save, () => { released = true; });
  runRenderer(context, "renderer/interaction-coordinator.js");
  runRenderer(context, "renderer/chat-model-settings-ui.js");
  let settings = modelSettings(managed);
  const commits = [];
  context.window.chatModelSettingsUi.bind({
    loadSuggestions: async () => {}, reconcileSettings: reconcile || (async () => {}),
    commitModel: (savedModel, originalModel) => {
      commits.push(savedModel);
      settings = replaceModel(settings, savedModel, originalModel);
      context.window.chatModelSettingsUi.render(settings);
    },
    resetConversation: (reason) => resets.push(reason),
    showToast: () => {},
  });
  context.window.chatModelSettingsUi.render(settings);
  return { context, elements, saved, resets, commits, released: () => released };
}

function replaceModel(settings, savedModel, originalModel) {
  const originalIdentity = identity(originalModel || savedModel);
  const models = settings.chatModels.filter((model) => identity(model) !== originalIdentity);
  models.push(savedModel);
  return { ...settings, chatModels: models };
}

function identity(model) {
  return `${model.provider_id}\u0000${model.model}`;
}

function modelSettings(managed) {
  return {
    providers: [{ provider_id: "openai", name: "OpenAI" }],
    chatModels: [{
      provider_id: "openai", model: "gpt-old", label: "Old",
      reasoning_effort: "high", managed, supports_archive_tools: true,
      evidence_character_limit: 24000,
    }],
  };
}

function chatModelElements() {
  const elements = {
    form: fakeElement("form"), provider: fakeElement("select"),
    modelId: fakeElement("input"), label: fakeElement("input"),
    effort: fakeElement("select"), saveButton: fakeElement("button"),
    archiveTools: fakeElement("input"), evidenceLimit: fakeElement("input"),
    cancelButton: fakeElement("button"), modelList: fakeElement("div"),
  };
  elements.archiveTools.checked = true;
  elements.evidenceLimit.value = "24000";
  elements.bySelector = selectorMap(elements);
  return elements;
}

function selectorMap(elements) {
  return new Map([
    ["#chat-model-form", elements.form], ["#chat-model-provider-select", elements.provider],
    ["#chat-model-input", elements.modelId], ["#chat-model-label", elements.label],
    ["#chat-model-reasoning-effort", elements.effort],
    ["#chat-model-archive-tools", elements.archiveTools],
    ["#chat-model-evidence-limit", elements.evidenceLimit],
    ["#save-chat-model-button", elements.saveButton],
    ["#cancel-chat-model-edit", elements.cancelButton],
    ["#chat-model-list", elements.modelList],
  ]);
}

function fixtureContext(elements, saved, save, releaseSelection) {
  return {
    document: {
      querySelector: (selector) => elements.bySelector.get(selector),
      createElement: (tagName) => fakeElement(tagName),
    },
    window: {
      chatContext: {
        saveChatModel: save || (async (input) => {
          saved.push(JSON.parse(JSON.stringify(input)));
          return savedModel(input);
        }),
        deleteChatModel: async () => {},
      },
      workspaceCache: { invalidate: () => {} },
      modelSelector: {
        getChatSelection: () => ({
          providerId: "openai", model: "gpt-old", reasoningEffort: "high",
          supportsArchiveTools: true, evidenceCharacterLimit: 24000,
        }),
        releaseSessionSelection: releaseSelection,
      },
    },
  };
}

function savedModel(input) {
  return {
    provider_id: input.providerId, model: input.model,
    label: input.label || input.model, reasoning_effort: input.reasoningEffort || null,
    managed: true, supports_archive_tools: input.supportsArchiveTools,
    evidence_character_limit: input.evidenceCharacterLimit,
  };
}

function fakeElement(tagName) {
  const attributes = new Map();
  const classes = new Set();
  return {
    tagName, children: [], listeners: {}, value: "", textContent: "", disabled: false,
    classList: classList(classes),
    addEventListener(name, callback) { this.listeners[name] = callback; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    reset() {},
    focus() { this.focused = true; },
  };
}

function classList(classes) {
  return {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const enabled = force === undefined ? !classes.has(name) : force;
      if (enabled) classes.add(name); else classes.delete(name);
    },
  };
}

function runRenderer(context, relativePath) {
  vm.runInNewContext(read(relativePath), context);
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
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
