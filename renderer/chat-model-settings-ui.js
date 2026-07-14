window.chatModelSettingsUi = (() => {
  let refreshSettings = async () => {};
  let loadSuggestions = async () => {};
  let resetConversation = () => {};
  let showToast = () => {};
  let editingModel = null;

  function bind(dependencies) {
    refreshSettings = dependencies.refreshSettings;
    loadSuggestions = dependencies.loadSuggestions;
    resetConversation = dependencies.resetConversation || (() => {});
    showToast = dependencies.showToast;
    ensureArchiveSettingsFields();
    document.querySelector("#chat-model-form").addEventListener("submit", saveModel);
    document.querySelector("#cancel-chat-model-edit").addEventListener("click", reset);
  }

  function render(settings) {
    const providers = new Map(settings.providers.map(
      (provider) => [provider.provider_id, provider.name],
    ));
    const rows = (settings.chatModels || []).map((model) => createModelRow(model, providers));
    if (!rows.length) rows.push(createDetail("Zatím není přidaný žádný chat model."));
    document.querySelector("#chat-model-list").replaceChildren(...rows);
  }

  function createModelRow(model, providers) {
    const reasoning = model.reasoning_effort || "výchozí dle modelu";
    const detail = `${providers.get(model.provider_id) || model.provider_id} · `
      + `${model.model} · reasoning ${reasoning}`;
    const retrieval = model.supports_archive_tools
      ? `adaptive · ${model.evidence_character_limit || 24000} znaků`
      : "deterministic";
    const row = createSettingsRow(model.label || model.model, `${detail} · ${retrieval}`);
    row.append(actionButton("Upravit", () => edit(model)));
    if (model.managed) {
      row.append(actionButton("Smazat", () => remove(model), "danger-link"));
    }
    return row;
  }

  async function saveModel(submitEvent) {
    submitEvent.preventDefault();
    const modelInput = formInput();
    const resetsChat = changesActiveModel(modelInput);
    const edited = Boolean(editingModel);
    try {
      await window.chatContext.saveChatModel(modelInput);
      reset();
      if (resetsChat) window.modelSelector.releaseSessionSelection();
      await refreshSettings();
      if (resetsChat) resetConversation("upraveným modelem");
      showToast(edited ? "Chat model byl upraven." : "Chat model byl přidán.");
    } catch (error) { showToast(error.message, true); }
  }

  function formInput() {
    return {
      providerId: document.querySelector("#chat-model-provider-select").value,
      model: document.querySelector("#chat-model-input").value,
      label: document.querySelector("#chat-model-label").value,
      reasoningEffort: document.querySelector("#chat-model-reasoning-effort").value,
      supportsArchiveTools: document.querySelector("#chat-model-archive-tools").checked,
      evidenceCharacterLimit: Number(
        document.querySelector("#chat-model-evidence-limit").value,
      ),
      ...(editingModel?.managed ? {
        originalProviderId: editingModel.provider_id,
        originalModel: editingModel.model,
      } : {}),
    };
  }

  function changesActiveModel(input) {
    if (!editingModel) return false;
    const active = window.modelSelector.getChatSelection();
    const editsActive = active.providerId === editingModel.provider_id
      && active.model === editingModel.model;
    return editsActive && (active.providerId !== input.providerId
      || active.model !== input.model
      || (active.reasoningEffort || "") !== input.reasoningEffort
      || active.supportsArchiveTools !== input.supportsArchiveTools
      || active.evidenceCharacterLimit !== input.evidenceCharacterLimit);
  }

  async function edit(model) {
    editingModel = model;
    document.querySelector("#chat-model-provider-select").value = model.provider_id;
    document.querySelector("#chat-model-input").value = model.model;
    document.querySelector("#chat-model-label").value = model.label || "";
    document.querySelector("#chat-model-reasoning-effort").value =
      model.reasoning_effort || "";
    document.querySelector("#chat-model-archive-tools").checked =
      Boolean(model.supports_archive_tools);
    document.querySelector("#chat-model-evidence-limit").value =
      model.evidence_character_limit || 24000;
    setIdentityFieldsLocked(!model.managed);
    updateFormMode();
    document.querySelector("#chat-model-input").focus();
    try { await loadSuggestions(); }
    catch (error) { showToast(error.message, true); }
  }

  function reset() {
    editingModel = null;
    document.querySelector("#chat-model-form").reset();
    setIdentityFieldsLocked(false);
    updateFormMode();
  }

  function setIdentityFieldsLocked(locked) {
    document.querySelector("#chat-model-provider-select").disabled = locked;
    document.querySelector("#chat-model-input").disabled = locked;
  }

  function ensureArchiveSettingsFields() {
    if (document.querySelector("#chat-model-archive-tools")) return;
    const actions = document.querySelector("#chat-model-form .settings-form-actions");
    actions.before(
      createFieldLabel("chat-model-archive-tools", "Archivní tools"),
      createArchiveToolsCheckbox(),
      createFieldLabel("chat-model-evidence-limit", "Limit evidence (znaky)"),
      createEvidenceLimitInput(),
    );
  }

  function createFieldLabel(controlId, text) {
    const label = document.createElement("label");
    label.htmlFor = controlId;
    label.textContent = text;
    return label;
  }

  function createArchiveToolsCheckbox() {
    const input = document.createElement("input");
    input.id = "chat-model-archive-tools";
    input.type = "checkbox";
    return input;
  }

  function createEvidenceLimitInput() {
    const input = document.createElement("input");
    input.id = "chat-model-evidence-limit";
    input.type = "number";
    input.min = "4000";
    input.max = "48000";
    input.step = "1000";
    input.value = "24000";
    input.required = true;
    return input;
  }

  function updateFormMode() {
    document.querySelector("#save-chat-model-button").textContent = editingModel
      ? "Uložit změny" : "Přidat model";
    document.querySelector("#cancel-chat-model-edit").classList.toggle(
      "hidden", !editingModel,
    );
  }

  async function remove(model) {
    if (editingModel?.provider_id === model.provider_id
      && editingModel?.model === model.model) reset();
    try {
      await window.chatContext.deleteChatModel(model.provider_id, model.model);
      await refreshSettings();
      showToast("Chat model byl smazán.");
    } catch (error) { showToast(error.message, true); }
  }

  function createSettingsRow(title, detail) {
    const row = document.createElement("article");
    const heading = document.createElement("strong");
    row.className = "settings-row";
    heading.textContent = title;
    row.append(heading, createDetail(detail));
    return row;
  }

  function createDetail(text) {
    const item = document.createElement("small");
    item.textContent = text;
    return item;
  }

  function actionButton(label, callback, className = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `settings-action ${className}`;
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  return { bind, render, reset };
})();
