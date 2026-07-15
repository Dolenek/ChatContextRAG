window.chatModelSettingsUi = (() => {
  let commitModel = () => {};
  let deleteModel = () => {};
  let reconcileSettings = async () => {};
  let loadSuggestions = async () => {};
  let resetConversation = () => {};
  let showToast = () => {};
  let editingModel = null;
  let renderedSettings = { providers: [], chatModels: [] };

  function bind(dependencies) {
    commitModel = dependencies.commitModel || (() => {});
    deleteModel = dependencies.deleteModel || (() => {});
    reconcileSettings = dependencies.reconcileSettings
      || dependencies.refreshSettings || (async () => {});
    loadSuggestions = dependencies.loadSuggestions;
    resetConversation = dependencies.resetConversation || (() => {});
    showToast = dependencies.showToast;
    ensureArchiveSettingsFields();
    document.querySelector("#chat-model-form").addEventListener("submit", saveModel);
    document.querySelector("#cancel-chat-model-edit").addEventListener("click", reset);
  }

  function render(settings) {
    renderedSettings = settings;
    renderModels(settings.chatModels || []);
  }

  function renderModels(models, pendingIdentity = null) {
    const providers = new Map(renderedSettings.providers.map(
      (provider) => [provider.provider_id, provider.name],
    ));
    const rows = models.map((model) => createModelRow(
      model, providers, modelIdentity(model) === pendingIdentity,
    ));
    if (!rows.length) rows.push(createDetail("Zatím není přidaný žádný chat model."));
    document.querySelector("#chat-model-list").replaceChildren(...rows);
  }

  function createModelRow(model, providers, pending = false) {
    const reasoning = model.reasoning_effort || "výchozí dle modelu";
    const detail = `${providers.get(model.provider_id) || model.provider_id} · `
      + `${model.model} · reasoning ${reasoning}`;
    const retrieval = model.supports_archive_tools
      ? `adaptive · ${model.evidence_character_limit || 24000} znaků`
      : "deterministic";
    const row = createSettingsRow(model.label || model.model, `${detail} · ${retrieval}`);
    if (pending) {
      row.classList.add("mutation-pending");
      row.setAttribute("aria-busy", "true");
      row.append(createDetail("Ukládám…"));
      return row;
    }
    row.append(actionButton("Upravit", () => edit(model)));
    if (model.managed) {
      const deleteButton = actionButton(
        "Smazat", () => remove(model, deleteButton), "danger-link",
      );
      row.append(deleteButton);
    }
    return row;
  }

  async function saveModel(submitEvent) {
    submitEvent.preventDefault();
    const modelInput = formInput();
    const resetsChat = changesActiveModel(modelInput);
    const originalModel = editingModel;
    const edited = Boolean(originalModel);
    const saveButton = document.querySelector("#save-chat-model-button");
    try {
      await window.interactionCoordinator.runMutation({
        key: "chat-model-form",
        controls: [{ element: saveButton, pendingText: "Ukládám…" }],
        apply: () => beginOptimisticSave(modelInput, originalModel),
        execute: () => window.chatContext.saveChatModel(modelInput),
        commit: (savedModel) => finishSave(
          savedModel, originalModel, resetsChat, edited,
        ),
        rollback: restoreSaveDraft,
        reconcile: reconcileSettings,
        reconcileFailed: showReconcileWarning,
      });
    } catch (error) { showToast(error.message, true); }
  }

  function beginOptimisticSave(modelInput, originalModel) {
    window.interactionCoordinator.supersede("settings-refresh");
    const draftSnapshot = captureDraft(originalModel);
    const projectedModel = projectModel(modelInput);
    const projectedModels = replaceProjectedModel(
      renderedSettings.chatModels || [], projectedModel, originalModel,
    );
    renderModels(projectedModels, modelIdentity(projectedModel));
    reset();
    return draftSnapshot;
  }

  function finishSave(savedModel, originalModel, resetsChat, edited) {
    commitModel(savedModel, originalModel);
    if (resetsChat) {
      window.modelSelector.releaseSessionSelection();
      resetConversation("upraveným modelem");
    }
    showToast(edited ? "Chat model byl upraven." : "Chat model byl přidán.");
  }

  function restoreSaveDraft(snapshot) {
    render(renderedSettings);
    editingModel = snapshot.editingModel;
    Object.entries(snapshot.values).forEach(([selector, value]) => {
      const control = document.querySelector(selector);
      if (selector === "#chat-model-archive-tools") control.checked = value;
      else control.value = value;
    });
    setIdentityFieldsLocked(Boolean(editingModel && !editingModel.managed));
    updateFormMode();
    document.querySelector("#chat-model-input").focus();
  }

  function captureDraft(originalModel) {
    return {
      editingModel: originalModel,
      values: {
        "#chat-model-provider-select": fieldValue("#chat-model-provider-select"),
        "#chat-model-input": fieldValue("#chat-model-input"),
        "#chat-model-label": fieldValue("#chat-model-label"),
        "#chat-model-reasoning-effort": fieldValue("#chat-model-reasoning-effort"),
        "#chat-model-archive-tools": document.querySelector(
          "#chat-model-archive-tools",
        ).checked,
        "#chat-model-evidence-limit": fieldValue("#chat-model-evidence-limit"),
      },
    };
  }

  function fieldValue(selector) {
    return document.querySelector(selector).value;
  }

  function projectModel(input) {
    return {
      provider_id: input.providerId, model: input.model.trim(),
      label: input.label.trim() || input.model.trim(),
      reasoning_effort: input.reasoningEffort || null, managed: true,
      supports_archive_tools: input.supportsArchiveTools,
      evidence_character_limit: input.evidenceCharacterLimit,
    };
  }

  function replaceProjectedModel(models, projectedModel, originalModel) {
    const originalKey = modelIdentity(originalModel || projectedModel);
    const targetKey = modelIdentity(projectedModel);
    const retained = models.filter((model) => {
      const key = modelIdentity(model);
      return key !== originalKey && key !== targetKey;
    });
    const originalIndex = models.findIndex((model) => modelIdentity(model) === originalKey);
    const fallbackIndex = retained.findIndex((model) => !model.managed);
    const insertionIndex = originalIndex >= 0
      ? Math.min(originalIndex, retained.length)
      : fallbackIndex >= 0 ? fallbackIndex : retained.length;
    retained.splice(insertionIndex, 0, projectedModel);
    return retained;
  }

  function modelIdentity(model) {
    return `${model.provider_id}\u0000${model.model}`;
  }

  function showReconcileWarning(error) {
    window.workspaceCache.invalidate("settings");
    showToast(`Změna je uložená, ale obnovení selhalo: ${error.message}`, true);
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
    const archiveTools = createArchiveToolsCheckbox();
    const evidenceLimit = createEvidenceLimitInput();
    actions.before(
      createHelpLabel(
        archiveTools, "Archivní tools",
        "Zapněte pouze pro modely, které podporují adaptivní function calling. Neplatný tool protokol skončí chybou.",
      ),
      archiveTools,
      createHelpLabel(
        evidenceLimit, "Limit evidence (znaky)",
        "Maximální množství archivních podkladů pro adaptivní odpověď. Povolený rozsah je 4 000 až 48 000 znaků; výchozí hodnota je 24 000.",
      ),
      evidenceLimit,
    );
  }

  function createHelpLabel(control, text, description) {
    const label = document.createElement("label");
    const term = document.createElement("span");
    const accessibleDescription = document.createElement("span");
    const descriptionId = `${control.id}-help`;
    label.htmlFor = control.id;
    term.className = "field-help-term";
    term.tabIndex = 0;
    term.textContent = text;
    term.setAttribute("data-tooltip", description);
    term.setAttribute("aria-describedby", descriptionId);
    accessibleDescription.id = descriptionId;
    accessibleDescription.className = "sr-only";
    accessibleDescription.setAttribute("role", "tooltip");
    accessibleDescription.textContent = description;
    control.setAttribute("aria-describedby", descriptionId);
    label.append(term, accessibleDescription);
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

  async function remove(model, deleteButton) {
    if (editingModel?.provider_id === model.provider_id
      && editingModel?.model === model.model) reset();
    try {
      await window.interactionCoordinator.runMutation({
        key: `delete-chat-model:${modelIdentity(model)}`,
        controls: [{ element: deleteButton, pendingText: "Mažu…" }],
        apply: () => null,
        execute: () => window.chatContext.deleteChatModel(model.provider_id, model.model),
        commit: () => deleteModel(model),
        reconcile: reconcileSettings,
        reconcileFailed: showReconcileWarning,
      });
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
