let settingsState = null;
let showSettingsScreen = () => {};
let showSettingsToast = () => {};

function bindSettingsUi(dependencies) {
  showSettingsScreen = dependencies.showScreen;
  showSettingsToast = dependencies.showToast;
  document.querySelector("#provider-form").addEventListener("submit", saveProvider);
  document.querySelector("#chat-model-form").addEventListener("submit", saveChatModel);
  document.querySelector("#embedding-index-form").addEventListener("submit", createIndex);
  document.querySelector("#cancel-provider-edit").addEventListener("click", resetProviderForm);
  document.querySelector("#refresh-settings-button").addEventListener("click", refreshSettings);
  document.querySelector("#embedding-provider-select").addEventListener("change", loadEmbeddingModels);
  document.querySelector("#chat-model-provider-select").addEventListener(
    "change", loadChatModelSuggestions,
  );
}

async function openSettings() {
  await window.chatContext.hideDiscord();
  showSettingsScreen("settings");
  await refreshSettings();
}

async function refreshSettings() {
  try {
    settingsState = await window.chatContext.getSettings();
    renderProviders();
    renderChatModels();
    renderIndexes();
    fillProviderSelect("#embedding-provider-select");
    fillProviderSelect("#chat-model-provider-select");
    await Promise.all([loadEmbeddingModels(), loadChatModelSuggestions()]);
    await window.modelSelector.prepare(settingsState);
  } catch (error) {
    showSettingsToast(error.message, true);
  }
}

async function refreshIndexState() {
  if (document.querySelector("#settings-screen").classList.contains("hidden")) return;
  settingsState = await window.chatContext.getSettings();
  renderIndexes();
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
    if (!provider.builtin) {
      row.append(
        actionButton("Upravit", () => editProvider(provider)),
        actionButton("Smazat", () => removeProvider(provider.provider_id), "danger-link"),
      );
    }
    return row;
  }));
}

function renderChatModels() {
  const providers = new Map(settingsState.providers.map(
    (provider) => [provider.provider_id, provider.name],
  ));
  const rows = (settingsState.chatModels || []).map((model) => {
    const detail = `${providers.get(model.provider_id) || model.provider_id} · ${model.model}`;
    const row = createSettingsRow(model.label || model.model, detail);
    if (model.managed) {
      row.append(actionButton(
        "Smazat", () => removeChatModel(model), "danger-link",
      ));
    }
    return row;
  });
  if (!rows.length) rows.push(createDetail("Zatím není přidaný žádný chat model."));
  document.querySelector("#chat-model-list").replaceChildren(...rows);
}

function renderIndexes() {
  const activeId = settingsState.embeddings.active_embedding_index_id;
  const rows = settingsState.embeddings.indexes.map((index) => {
    const label = `${index.model} · ${index.dimensions}D · ${index.chunk_count} chunků`;
    const row = createSettingsRow(index.name, `${label} · ${index.status}`);
    const toggle = document.createElement("label");
    toggle.className = "compact-toggle";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = index.auto_sync;
    checkbox.addEventListener("change", () => updateAutoSync(index, checkbox.checked));
    toggle.append(checkbox, document.createTextNode(" Auto-sync"));
    row.append(toggle);
    if (index.embedding_index_id !== activeId && index.status === "ready") {
      row.append(actionButton("Aktivovat", () => activateIndex(index.embedding_index_id)));
    } else if (index.embedding_index_id === activeId) {
      row.classList.add("active-settings-row");
    }
    if (index.pending_message_count && !index.active_job_id) {
      row.append(actionButton(`Sync ${index.pending_message_count}`, () => syncIndex(index)));
    }
    if (!index.active_job_id) {
      row.append(actionButton("Rebuild", () => rebuildIndex(index)));
    }
    if (index.embedding_index_id !== activeId) {
      row.append(actionButton("Smazat", () => removeIndex(index), "danger-link"));
    }
    if (index.last_error && !index.active_job_id) {
      row.append(createDetail(index.last_error, "error-detail"));
    }
    return row;
  });
  document.querySelector("#embedding-index-list").replaceChildren(...rows);
}

async function saveProvider(submitEvent) {
  submitEvent.preventDefault();
  try {
    await window.chatContext.saveProvider({
      providerId: document.querySelector("#provider-id").value || undefined,
      name: document.querySelector("#provider-name").value,
      baseUrl: document.querySelector("#provider-base-url").value,
      apiKey: document.querySelector("#provider-api-key").value,
      chatApi: document.querySelector("#provider-chat-api").value,
    });
    resetProviderForm();
    await refreshSettings();
    showSettingsToast("Provider byl uložen.");
  } catch (error) { showSettingsToast(error.message, true); }
}

async function saveChatModel(submitEvent) {
  submitEvent.preventDefault();
  try {
    await window.chatContext.saveChatModel({
      providerId: document.querySelector("#chat-model-provider-select").value,
      model: document.querySelector("#chat-model-input").value,
      label: document.querySelector("#chat-model-label").value,
    });
    document.querySelector("#chat-model-input").value = "";
    document.querySelector("#chat-model-label").value = "";
    await refreshSettings();
    showSettingsToast("Chat model byl přidán.");
  } catch (error) { showSettingsToast(error.message, true); }
}

async function createIndex(submitEvent) {
  submitEvent.preventDefault();
  const dimensionsValue = document.querySelector("#embedding-dimensions").value;
  try {
    const created = await window.chatContext.createEmbeddingIndex({
      name: document.querySelector("#embedding-index-name").value,
      provider_id: document.querySelector("#embedding-provider-select").value,
      model: document.querySelector("#embedding-model-input").value,
      requested_dimensions: dimensionsValue ? Number(dimensionsValue) : null,
      auto_sync: document.querySelector("#embedding-auto-sync").checked,
    });
    submitEvent.target.reset();
    await refreshSettings();
    showSettingsToast(`Index ${created.name} byl vytvořen.`);
  } catch (error) { showSettingsToast(error.message, true); }
}

function editProvider(provider) {
  document.querySelector("#provider-id").value = provider.provider_id;
  document.querySelector("#provider-name").value = provider.name;
  document.querySelector("#provider-base-url").value = provider.base_url;
  document.querySelector("#provider-chat-api").value = provider.chat_api;
  document.querySelector("#provider-api-key").value = "";
}

function resetProviderForm() { document.querySelector("#provider-form").reset(); document.querySelector("#provider-id").value = ""; }
async function removeProvider(id) { await runAndRefresh(() => window.chatContext.deleteProvider(id), "Provider byl smazán."); }
async function removeChatModel(model) {
  await runAndRefresh(
    () => window.chatContext.deleteChatModel(model.provider_id, model.model),
    "Chat model byl smazán.",
  );
}
async function activateIndex(id) { await runAndRefresh(() => window.chatContext.activateEmbeddingIndex(id), "Aktivní index byl změněn."); }
async function syncIndex(index) { await runAndRefresh(() => window.chatContext.syncEmbeddingIndex(index.embedding_index_id), "Synchronizace byla zařazena."); }
async function rebuildIndex(index) {
  if (!confirm(`Znovu embedovat všechny raw zprávy pro ${index.name}?`)) return;
  await runAndRefresh(
    () => window.chatContext.rebuildEmbeddingIndex(index.embedding_index_id),
    "Rebuild byl zařazen.",
  );
}
async function removeIndex(index) { if (confirm(`Smazat index ${index.name}? Raw zprávy zůstanou zachované.`)) await runAndRefresh(() => window.chatContext.deleteEmbeddingIndex(index.embedding_index_id), "Index byl smazán."); }
async function updateAutoSync(index, enabled) { await runAndRefresh(() => window.chatContext.updateEmbeddingIndex(index.embedding_index_id, { auto_sync: enabled }), "Auto-sync byl změněn."); }

async function runAndRefresh(operation, message) {
  try { await operation(); await refreshSettings(); showSettingsToast(message); }
  catch (error) { showSettingsToast(error.message, true); }
}

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
  await loadModels(document.querySelector("#embedding-provider-select").value, "#embedding-model-options");
}

async function loadChatModelSuggestions() {
  await loadModels(
    document.querySelector("#chat-model-provider-select").value,
    "#chat-model-options",
  );
}

async function loadModels(providerId, datalistSelector) {
  if (!providerId) return;
  const result = await window.chatContext.listProviderModels(providerId);
  const options = result.models.map((model) => {
    const option = document.createElement("option"); option.value = model; return option;
  });
  document.querySelector(datalistSelector).replaceChildren(...options);
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
