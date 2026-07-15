let settingsState = null;
let showSettingsToast = () => {};
let prepareSettingsOpen = async () => {};

function bindSettingsUi(dependencies) {
  showSettingsToast = dependencies.showToast;
  prepareSettingsOpen = dependencies.prepareOpen;
  window.settingsMutationUi.bind({
    reconcile: () => refreshSettings({ silent: true }),
    showToast: showSettingsToast,
  });
  window.settingsEntityActions.bind({ updateSettings });
  window.settingsProviderProjection.bind({
    getState: () => settingsState, updateSettings, resetForm: resetProviderForm,
  });
  window.chatModelSettingsUi.bind({
    commitModel: commitChatModel,
    deleteModel: commitDeletedChatModel,
    loadSuggestions: window.settingsModelSuggestions.loadChat,
    reconcileSettings: () => refreshSettings({ silent: true }),
    resetConversation: dependencies.resetConversation,
    showToast: showSettingsToast,
  });
  window.settingsOverlay.bind({ onClose: resetSettingsDrafts });
  window.workspaceTimezoneUi.bind({
    projectTimezone: updateWorkspaceTimezone, showToast: showSettingsToast,
  });
  document.querySelector("#provider-form").addEventListener("submit", saveProvider);
  window.indexingApiKeyUi.bind({
    refreshSettings, commitProvider: commitProviderProfile,
    showToast: showSettingsToast,
  });
  window.indexingJobHistoryUi.bind({
    refreshSettings, showToast: showSettingsToast,
  });
  document.querySelector("#embedding-index-form").addEventListener("submit", createIndex);
  document.querySelector("#cancel-provider-edit").addEventListener("click", resetProviderForm);
  document.querySelector("#refresh-settings-button").addEventListener(
    "click", () => refreshSettings({ requestReadModel: true }),
  );
  document.querySelector("#embedding-provider-select").addEventListener("change", loadEmbeddingModels);
  document.querySelector("#chat-model-provider-select").addEventListener(
    "change", loadChatModelSuggestionsSafely,
  );
  window.connectionSettingsUi.bind({ showToast: showSettingsToast });
  window.discordBotSettingsUi.bind({ showToast: showSettingsToast });
}

async function openSettings(sectionName = "providers") {
  await prepareSettingsOpen();
  resetSettingsDrafts();
  window.settingsOverlay.open(sectionName);
  await Promise.all([
    window.runtimeCapabilitiesUi.refresh()
      .catch((error) => showSettingsToast(error.message, true)),
    window.connectionSettingsUi.refresh(),
    refreshSettings(),
  ]);
}

async function refreshSettings(options = {}) {
  try {
    if (options.requestReadModel) await requestSettingsReadModel();
    return await window.interactionCoordinator.runLatest(
      "settings-refresh", loadSettingsPayload, applySettingsPayload,
    );
  } catch (error) {
    if (options.silent) throw error;
    showSettingsToast(error.message, true);
  }
}

async function requestSettingsReadModel() {
  await window.chatContext.refreshReadModel("all");
  void window.overviewController.refreshStatus({ forceClient: true });
}

async function applySettingsPayload(payload) {
  commitSettingsState(payload.settings);
  renderProviders();
  window.indexingApiKeyUi.render(settingsState);
  window.chatModelSettingsUi.render(settingsState);
  window.workspaceTimezoneUi.render(settingsState.workspace);
  renderIndexes();
  window.indexingJobHistoryUi.render(payload.indexingJobs);
  fillProviderSelect("#embedding-provider-select");
  fillProviderSelect("#chat-model-provider-select");
  await Promise.all([
    window.settingsModelSuggestions.loadEmbedding(),
    window.settingsModelSuggestions.loadChat(),
  ]);
  await window.modelSelector.prepare(settingsState);
  await window.discordBotSettingsUi.refresh(settingsState);
}

function commitChatModel(savedModel, originalModel) {
  if (!settingsState) return;
  window.interactionCoordinator.supersede("settings-refresh");
  window.interactionCoordinator.supersede("settings-index-refresh");
  settingsState = {
    ...settingsState,
    chatModels: replaceChatModel(settingsState.chatModels || [], savedModel, originalModel),
  };
  window.workspaceCache.store("settings", settingsState);
  window.chatModelSettingsUi.render(settingsState);
  void window.modelSelector.prepare(settingsState);
}

function commitDeletedChatModel(deletedModel) {
  if (!settingsState) return;
  window.interactionCoordinator.supersede("settings-refresh");
  settingsState = {
    ...settingsState,
    chatModels: settingsState.chatModels.filter(
      (model) => modelIdentity(model) !== modelIdentity(deletedModel),
    ),
  };
  window.workspaceCache.store("settings", settingsState);
  window.chatModelSettingsUi.render(settingsState);
  void window.modelSelector.prepare(settingsState);
}

function replaceChatModel(models, savedModel, originalModel) {
  const originalKey = modelIdentity(originalModel || savedModel);
  const targetKey = modelIdentity(savedModel);
  const retained = models.filter((model) => {
    const key = modelIdentity(model);
    return key !== originalKey && key !== targetKey;
  });
  const originalIndex = models.findIndex((model) => modelIdentity(model) === originalKey);
  const fallbackIndex = retained.findIndex((model) => !model.managed);
  const insertionIndex = originalIndex >= 0
    ? Math.min(originalIndex, retained.length)
    : fallbackIndex >= 0 ? fallbackIndex : retained.length;
  retained.splice(insertionIndex, 0, savedModel);
  return retained;
}

function modelIdentity(model) {
  return `${model.provider_id}\u0000${model.model}`;
}

async function refreshIndexState() {
  if (!window.settingsOverlay.isOpen()) return;
  await window.interactionCoordinator.runLatest(
    "settings-index-refresh", loadSettingsPayload, (payload) => {
      commitSettingsState(payload.settings);
      renderIndexes();
      window.indexingJobHistoryUi.render(payload.indexingJobs);
    },
  );
}

async function loadSettingsPayload() {
  const [nextSettings, status] = await Promise.all([
    window.chatContext.getSettings(),
    window.chatContext.getDatabaseStatus(),
  ]);
  return { settings: nextSettings, indexingJobs: status.indexing_jobs || [] };
}

function commitSettingsState(nextSettings) {
  settingsState = nextSettings;
  window.workspaceCache.store("settings", nextSettings);
}

function renderProviders() {
  const container = document.querySelector("#provider-list");
  container.replaceChildren(...settingsState.providers.map((provider) => {
    const availability = provider.is_available ?? provider.has_api_key;
    const access = provider.has_api_key ? "API klíč uložen"
      : availability ? "lokální endpoint bez klíče" : "chybí API klíč";
    const row = createSettingsRow(
      provider.name, `${provider.base_url} · ${provider.chat_api} · ${access}`,
    );
    if (provider._pending) {
      row.append(createDetail("Ukládám…"));
      return row;
    }
    if (provider.builtin) {
      row.append(actionButton(
        provider.has_api_key ? "Změnit API klíč" : "Nastavit klíč pro indexing",
        () => window.indexingApiKeyUi.select(provider.provider_id),
      ));
    } else {
      const deleteButton = actionButton(
        "Smazat", () => removeProvider(provider.provider_id, deleteButton), "danger-link",
      );
      row.append(
        actionButton("Upravit", () => editProvider(provider)),
        deleteButton,
      );
    }
    return row;
  }));
}

function renderIndexes() {
  const activeId = settingsState.embeddings.active_embedding_index_id;
  const rows = settingsState.embeddings.indexes.map(
    (index) => createIndexRow(index, activeId),
  );
  document.querySelector("#embedding-index-list").replaceChildren(...rows);
}

function createIndexRow(index, activeId) {
  const chunkCount = index.summary_ready === false ? "—" : index.chunk_count;
  const label = `${index.model} · ${index.dimensions}D · ${chunkCount} chunků`;
  const row = createSettingsRow(index.name, `${label} · ${index.status}`);
  appendIndexSummaryState(row, index);
  row.append(createAutoSyncToggle(index));
  appendIndexActions(row, index, activeId);
  if (index.last_error && !index.active_job_id) {
    row.append(createDetail(index.last_error, "error-detail"));
  }
  return row;
}

function createAutoSyncToggle(index) {
  const toggle = document.createElement("label");
  const checkbox = document.createElement("input");
  toggle.className = "compact-toggle";
  checkbox.type = "checkbox";
  checkbox.checked = index.auto_sync;
  checkbox.addEventListener("change", () => updateAutoSync(index, checkbox));
  toggle.append(checkbox, document.createTextNode(" Auto-sync"));
  return toggle;
}

function appendIndexActions(row, index, activeId) {
  if (index.embedding_index_id !== activeId && index.status === "ready") {
    const activateButton = actionButton(
      "Aktivovat", () => activateIndex(index.embedding_index_id, activateButton),
    );
    row.append(activateButton);
  } else if (index.embedding_index_id === activeId) {
    row.classList.add("active-settings-row");
  }
  if (index.summary_ready !== false && index.pending_message_count && !index.active_job_id) {
    const syncButton = actionButton(
      `Sync ${index.pending_message_count}`, () => syncIndex(index, syncButton),
    );
    row.append(syncButton);
  }
  if (!index.active_job_id) {
    const rebuildButton = actionButton(
      "Rebuild", () => rebuildIndex(index, rebuildButton),
    );
    row.append(rebuildButton);
  }
  if (index.embedding_index_id !== activeId) {
    const deleteButton = actionButton(
      "Smazat", () => removeIndex(index, deleteButton), "danger-link",
    );
    row.append(deleteButton);
  }
}

function appendIndexSummaryState(row, index) {
  if (index.summary_ready === false) {
    row.append(createDetail("Připravuji souhrn…"));
  } else if (index.summary_error) {
    row.append(createDetail("Obnova souhrnu selhala. Zkuste ji spustit znovu.", "error-detail"));
  } else if (index.summary_refreshing || index.summary_is_stale) {
    row.append(createDetail("Souhrn se aktualizuje…"));
  }
}

async function saveProvider(submitEvent) {
  submitEvent.preventDefault();
  const providerInput = window.settingsProviderProjection.readForm();
  await window.settingsMutationUi.run({
    key: `save-provider:${providerInput.providerId || "new"}`,
    control: submitEvent.submitter, pendingText: "Ukládám…",
    apply: () => window.settingsProviderProjection.projectPending(providerInput),
    execute: () => window.chatContext.saveProvider(providerInput),
    commit: window.settingsProviderProjection.commit,
    rollback: window.settingsProviderProjection.rollback,
    successMessage: "Provider byl uložen.",
  });
}

async function createIndex(submitEvent) {
  submitEvent.preventDefault();
  const dimensionsValue = document.querySelector("#embedding-dimensions").value;
  const indexInput = {
    name: document.querySelector("#embedding-index-name").value,
    provider_id: document.querySelector("#embedding-provider-select").value,
    model: document.querySelector("#embedding-model-input").value,
    requested_dimensions: dimensionsValue ? Number(dimensionsValue) : null,
    auto_sync: document.querySelector("#embedding-auto-sync").checked,
  };
  await window.settingsMutationUi.run({
    key: "create-embedding-index", control: submitEvent.submitter,
    pendingText: "Zařazuji…", execute: () => window.chatContext.createEmbeddingIndex(indexInput),
    commit: (created) => commitCreatedIndex(created, submitEvent.target),
    databaseChanged: () => window.overviewController.markDatabaseChanged(),
    successMessage: (created) => `Index ${created.name} byl vytvořen.`,
  });
}

function commitCreatedIndex(created, form) {
  updateSettings((state) => ({ ...state, embeddings: {
    ...state.embeddings,
    indexes: [...state.embeddings.indexes.filter(
      (index) => index.embedding_index_id !== created.embedding_index_id,
    ), created],
  } }));
  form.reset();
}

function commitProviderProfile(savedProvider) {
  updateSettings((state) => ({ ...state, providers: [
    ...state.providers.filter(
      (provider) => provider.provider_id !== savedProvider.provider_id,
    ),
    savedProvider,
  ] }));
}

function updateSettings(project) {
  const previousState = settingsState;
  window.interactionCoordinator.supersede("settings-refresh");
  settingsState = project(settingsState);
  window.workspaceCache.store("settings", settingsState);
  renderProviders();
  renderIndexes();
  void window.modelSelector?.prepare(settingsState);
  return previousState;
}

function updateWorkspaceTimezone(timezoneName) {
  const previousTimezone = settingsState.workspace.timezone_name;
  updateSettings((state) => ({ ...state, workspace: {
    ...state.workspace, timezone_name: timezoneName,
  } }));
  return previousTimezone;
}

function editProvider(provider) {
  document.querySelector("#provider-id").value = provider.provider_id;
  document.querySelector("#provider-name").value = provider.name;
  document.querySelector("#provider-base-url").value = provider.base_url;
  document.querySelector("#provider-chat-api").value = provider.chat_api;
  document.querySelector("#provider-api-key").value = "";
}

function resetProviderForm() { document.querySelector("#provider-form").reset(); document.querySelector("#provider-id").value = ""; }

function resetSettingsDrafts() {
  [
    "#connection-form", "#provider-form", "#indexing-api-key-form",
    "#embedding-index-form",
  ].forEach((selector) => document.querySelector(selector).reset());
  window.chatModelSettingsUi.reset();
  document.querySelector("#provider-id").value = "";
  document.querySelector("#connection-token").value = "";
}
function removeProvider(...args) { return window.settingsEntityActions.removeProvider(...args); }
function activateIndex(...args) { return window.settingsEntityActions.activateIndex(...args); }
function syncIndex(...args) { return window.settingsEntityActions.syncIndex(...args); }
function rebuildIndex(...args) { return window.settingsEntityActions.rebuildIndex(...args); }
function removeIndex(...args) { return window.settingsEntityActions.removeIndex(...args); }
function updateAutoSync(...args) { return window.settingsEntityActions.updateAutoSync(...args); }

function fillProviderSelect(selector) {
  const select = document.querySelector(selector);
  const previous = select.value;
  select.replaceChildren(...settingsState.providers.map((provider) => {
    const option = document.createElement("option");
    const available = provider.is_available ?? provider.has_api_key;
    option.value = provider.provider_id;
    option.textContent = available ? provider.name : `${provider.name} (chybí klíč)`;
    return option;
  }));
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function loadEmbeddingModels() {
  try { await window.settingsModelSuggestions.loadEmbedding(); }
  catch (error) { showSettingsToast(error.message, true); }
}

async function loadChatModelSuggestionsSafely() {
  try { await window.settingsModelSuggestions.loadChat(); }
  catch (error) { showSettingsToast(error.message, true); }
}

function createSettingsRow(title, detail) {
  const row = document.createElement("article"); row.className = "settings-row";
  const heading = document.createElement("strong"); heading.textContent = title;
  row.append(heading, createDetail(detail)); return row;
}
function createDetail(text, className = "") { const item = document.createElement("small"); item.className = className; item.textContent = text; return item; }
function actionButton(label, callback, className = "") { const button = document.createElement("button"); button.type = "button"; button.className = `settings-action ${className}`; button.textContent = label; button.addEventListener("click", callback); return button; }

window.settingsUi = {
  bind: bindSettingsUi, open: openSettings,
  refresh: refreshSettings, refreshIndexState,
};
