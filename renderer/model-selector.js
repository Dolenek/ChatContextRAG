window.modelSelector = (() => {
  const selector = document.querySelector("#model-selector");
  const trigger = document.querySelector("#chat-model-trigger");
  const menu = document.querySelector("#chat-model-menu");
  const providerList = document.querySelector("#model-provider-list");
  const modelList = document.querySelector("#model-list");
  let settingsState = null;
  let activeProviderId = null;
  let selection = { providerId: "openai", model: "", reasoningEffort: null };
  let preserveSessionSelection = false;
  let showToast = () => {};
  let resetConversation = () => {};

  function bind(dependencies) {
    showToast = dependencies.showToast;
    resetConversation = dependencies.resetConversation;
    trigger.addEventListener("click", toggleMenu);
    document.addEventListener("click", closeFromOutside);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }

  async function prepare(providedSettings = null) {
    settingsState = providedSettings || await window.chatContext.getSettings();
    if (preserveSessionSelection) {
      render();
      return;
    }
    const defaults = settingsState.chatDefaults || {};
    const preferred = findModel(defaults.chatProviderId, defaults.chatModel);
    const fallback = availableModels().find((model) => providerAvailable(model.provider_id))
      || availableModels()[0];
    const selectedModel = preferred || fallback;
    selection = selectedModel
      ? selectionFromModel(selectedModel)
      : {
        providerId: defaults.chatProviderId || "openai",
        model: defaults.chatModel || "", reasoningEffort: null,
      };
    activeProviderId = selection.providerId;
    render();
  }

  function getChatSelection() {
    return { ...selection };
  }

  function restoreSelection(providerId, model, reasoningEffort = null) {
    selection = {
      providerId: providerId || "", model: model || "",
      reasoningEffort: reasoningEffort || null,
    };
    preserveSessionSelection = true;
    activeProviderId = selection.providerId;
    render();
    return Boolean(findModel(selection.providerId, selection.model))
      && providerAvailable(selection.providerId);
  }

  function releaseSessionSelection() {
    preserveSessionSelection = false;
  }

  function toggleMenu(event) {
    event.stopPropagation();
    if (menu.classList.contains("hidden")) openMenu();
    else closeMenu();
  }

  function openMenu() {
    activeProviderId = selection.providerId || availableModels()[0]?.provider_id;
    renderProviderMenu();
    renderModelMenu();
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
  }

  function closeMenu() {
    menu.classList.add("hidden");
    modelList.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  }

  function closeFromOutside(event) {
    if (!selector.contains(event.target)) closeMenu();
  }

  function render() {
    renderTrigger();
    renderProviderMenu();
    renderModelMenu();
    updateChatAvailability();
  }

  function renderTrigger() {
    const model = findModel(selection.providerId, selection.model);
    const provider = findProvider(selection.providerId);
    const modelLabel = model?.label || selection.model || "Žádný model";
    document.querySelector("#selected-model-label").textContent = selection.reasoningEffort
      ? `${modelLabel} · ${selection.reasoningEffort}` : modelLabel;
    trigger.title = provider && selection.model
      ? modelSelectionTitle(provider.name) : "V Nastavení přidejte chat model";
    trigger.disabled = !availableModels().length;
  }

  function renderProviderMenu() {
    const providerIds = [...new Set(availableModels().map((model) => model.provider_id))];
    const buttons = providerIds.map((providerId) => createProviderButton(providerId));
    providerList.replaceChildren(...buttons);
  }

  function createProviderButton(providerId) {
    const provider = findProvider(providerId);
    const button = document.createElement("button");
    const label = document.createElement("span");
    const arrow = document.createElement("span");
    button.className = "model-menu-button";
    button.classList.toggle("active", providerId === activeProviderId);
    button.type = "button";
    button.disabled = !providerAvailable(providerId);
    label.textContent = provider?.name || providerId;
    arrow.textContent = "‹";
    arrow.setAttribute("aria-hidden", "true");
    button.append(label, arrow);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      activeProviderId = providerId;
      renderProviderMenu();
      renderModelMenu();
    });
    return button;
  }

  function renderModelMenu() {
    const models = availableModels().filter((model) => model.provider_id === activeProviderId);
    if (!models.length) {
      modelList.replaceChildren(createEmptyModelLabel());
      modelList.classList.remove("hidden");
      return;
    }
    modelList.replaceChildren(...models.map(createModelButton));
    modelList.classList.remove("hidden");
  }

  function createModelButton(model) {
    const button = document.createElement("button");
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    const identifier = document.createElement("small");
    const checkmark = document.createElement("span");
    const selected = model.provider_id === selection.providerId
      && model.model === selection.model
      && (model.reasoning_effort || null) === selection.reasoningEffort;
    button.className = "model-menu-button";
    button.type = "button";
    label.textContent = model.label || model.model;
    identifier.textContent = modelDescription(model);
    checkmark.className = "checkmark";
    checkmark.textContent = selected ? "✓" : "";
    copy.append(label, identifier);
    button.append(copy, checkmark);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      void selectModel(model);
    });
    return button;
  }

  async function selectModel(model) {
    const previousSelection = selection;
    const previousPreserveSessionSelection = preserveSessionSelection;
    selection = selectionFromModel(model);
    preserveSessionSelection = false;
    render();
    closeMenu();
    try {
      await window.chatContext.saveChatDefault(selection.providerId, selection.model);
      if (settingsState) settingsState.chatDefaults = { ...selection };
      resetConversation("novým modelem");
    } catch (error) {
      selection = previousSelection;
      preserveSessionSelection = previousPreserveSessionSelection;
      render();
      showToast(error.message, true);
    }
  }

  function updateChatAvailability() {
    const activeIndex = settingsState?.embeddings.indexes.find((index) =>
      index.embedding_index_id === settingsState.embeddings.active_embedding_index_id);
    const embeddingReady = activeIndex?.status === "ready"
      && providerAvailable(activeIndex.provider_id);
    const chatReady = Boolean(findModel(selection.providerId, selection.model))
      && providerAvailable(selection.providerId);
    const readOnly = window.chatController?.isReadOnly?.() || false;
    document.querySelector("#chat-form button[type='submit']").disabled =
      readOnly || !embeddingReady || !chatReady;
    document.querySelector("#active-embedding-index").textContent = activeIndex
      ? `RAG: ${activeIndex.name}` : "Není vybraný připravený RAG index";
  }

  function availableModels() {
    return settingsState?.chatModels || [];
  }

  function findModel(providerId, modelId) {
    return availableModels().find((model) =>
      model.provider_id === providerId && model.model === modelId);
  }

  function selectionFromModel(model) {
    return {
      providerId: model.provider_id, model: model.model,
      reasoningEffort: model.reasoning_effort || null,
    };
  }

  function modelSelectionTitle(providerName) {
    const effort = selection.reasoningEffort
      ? ` · reasoning ${selection.reasoningEffort}` : " · výchozí reasoning";
    return `${providerName} · ${selection.model}${effort}`;
  }

  function modelDescription(model) {
    const parts = [];
    if (model.label && model.label !== model.model) parts.push(model.model);
    parts.push(model.reasoning_effort
      ? `reasoning ${model.reasoning_effort}` : "výchozí reasoning");
    return parts.join(" · ");
  }

  function findProvider(providerId) {
    return settingsState?.providers.find((provider) => provider.provider_id === providerId);
  }

  function providerAvailable(providerId) {
    const provider = findProvider(providerId);
    return Boolean(provider && (provider.is_available ?? provider.has_api_key));
  }

  function createEmptyModelLabel() {
    const label = document.createElement("span");
    label.className = "model-menu-empty";
    label.textContent = "Provider nemá přidané žádné chat modely.";
    return label;
  }

  return {
    bind, getChatSelection, prepare, restoreSelection,
    releaseSessionSelection,
    updateAvailability: updateChatAvailability,
  };
})();
