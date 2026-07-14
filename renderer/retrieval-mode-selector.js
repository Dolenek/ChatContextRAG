window.retrievalModeSelector = (() => {
  const selector = document.querySelector("#retrieval-mode-select");
  let selectedModel = defaultModelCapabilities();
  let preserveSessionSelection = false;
  let resetConversation = () => {};

  function bind(dependencies) {
    resetConversation = dependencies.resetConversation;
    selector.addEventListener("change", () => {
      preserveSessionSelection = false;
      resetConversation("novým režimem vyhledávání");
    });
  }

  function applyModel(modelSelection) {
    selectedModel = normalizeCapabilities(modelSelection);
    if (!preserveSessionSelection) selector.value = defaultMode();
    updateAvailability();
  }

  function getSelection() {
    return {
      retrievalMode: selector.value,
      evidenceCharacterLimit: selector.value === "adaptive"
        ? selectedModel.evidenceCharacterLimit : null,
    };
  }

  function restore(retrievalMode, evidenceCharacterLimit) {
    preserveSessionSelection = true;
    selector.value = retrievalMode || "deterministic";
    if (evidenceCharacterLimit) selectedModel.evidenceCharacterLimit = evidenceCharacterLimit;
    updateAvailability();
    return true;
  }

  function release() {
    preserveSessionSelection = false;
    selector.value = defaultMode();
    updateAvailability();
  }

  function updateAvailability() {
    selector.querySelector("option[value='adaptive']").disabled =
      !selectedModel.supportsArchiveTools;
    if (!selectedModel.supportsArchiveTools && !preserveSessionSelection) {
      selector.value = "deterministic";
    }
    selector.title = selectedModel.supportsArchiveTools
      ? "Způsob práce s archivem"
      : "Vybraný model nepodporuje archivní nástroje";
  }

  function defaultMode() {
    return selectedModel.supportsArchiveTools ? "adaptive" : "deterministic";
  }

  function normalizeCapabilities(modelSelection = {}) {
    return {
      supportsArchiveTools: Boolean(modelSelection.supportsArchiveTools),
      evidenceCharacterLimit: modelSelection.evidenceCharacterLimit || 24000,
    };
  }

  function defaultModelCapabilities() {
    return { supportsArchiveTools: false, evidenceCharacterLimit: 24000 };
  }

  return { applyModel, bind, getSelection, release, restore };
})();
