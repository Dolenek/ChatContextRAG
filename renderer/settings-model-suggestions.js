window.settingsModelSuggestions = (() => {
  function loadChat() {
    return loadForProvider({
      key: "chat-model-suggestions",
      select: "#chat-model-provider-select",
      input: "#chat-model-input",
      datalist: "#chat-model-options",
    });
  }

  function loadEmbedding() {
    return loadForProvider({
      key: "embedding-model-suggestions",
      select: "#embedding-provider-select",
      input: "#embedding-model-input",
      datalist: "#embedding-model-options",
    });
  }

  async function loadForProvider(target) {
    const select = document.querySelector(target.select);
    const input = document.querySelector(target.input);
    const datalist = document.querySelector(target.datalist);
    const providerId = select.value;
    datalist.replaceChildren();
    if (!providerId) {
      window.interactionCoordinator.supersede(target.key);
      input.removeAttribute("aria-busy");
      return { status: "empty" };
    }
    input.setAttribute("aria-busy", "true");
    try {
      return await window.interactionCoordinator.runLatest(
        target.key,
        () => window.chatContext.listProviderModels(providerId),
        (result) => applySuggestions(target, providerId, result.models),
      );
    } catch (error) {
      if (select.value === providerId) input.removeAttribute("aria-busy");
      throw error;
    }
  }

  function applySuggestions(target, providerId, models) {
    const select = document.querySelector(target.select);
    if (select.value !== providerId) return;
    const options = models.map((model) => {
      const option = document.createElement("option");
      option.value = model;
      return option;
    });
    document.querySelector(target.datalist).replaceChildren(...options);
    document.querySelector(target.input).removeAttribute("aria-busy");
  }

  return { loadChat, loadEmbedding };
})();
