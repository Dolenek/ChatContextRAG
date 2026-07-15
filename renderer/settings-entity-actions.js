window.settingsEntityActions = (() => {
  let updateSettings = () => {};

  function bind(dependencies) {
    updateSettings = dependencies.updateSettings;
  }

  async function removeProvider(id, button) {
    await pendingAction({
      key: `delete-provider:${id}`, control: button, pendingText: "Mažu…",
      execute: () => window.chatContext.deleteProvider(id),
      commit: () => updateSettings((state) => ({
        ...state, providers: state.providers.filter((provider) => provider.provider_id !== id),
      })),
      successMessage: "Provider byl smazán.",
    });
  }

  async function activateIndex(id, button) {
    await optimisticIndexUpdate({
      key: "activate-index", control: button, pendingText: "Aktivuji…",
      project: (state) => ({ ...state, embeddings: {
        ...state.embeddings, active_embedding_index_id: id,
      } }),
      execute: () => window.chatContext.activateEmbeddingIndex(id),
      successMessage: "Aktivní index byl změněn.",
    });
  }

  async function syncIndex(index, button) {
    await pendingAction({
      key: `sync-index:${index.embedding_index_id}`, control: button,
      pendingText: "Zařazuji…",
      execute: () => window.chatContext.syncEmbeddingIndex(index.embedding_index_id),
      successMessage: "Synchronizace byla zařazena.", databaseChanged: true,
    });
  }

  async function rebuildIndex(index, button) {
    if (!confirm(`Znovu embedovat všechny raw zprávy pro ${index.name}?`)) return;
    await pendingAction({
      key: `rebuild-index:${index.embedding_index_id}`, control: button,
      pendingText: "Zařazuji…",
      execute: () => window.chatContext.rebuildEmbeddingIndex(index.embedding_index_id),
      successMessage: "Rebuild byl zařazen.", databaseChanged: true,
    });
  }

  async function removeIndex(index, button) {
    if (!confirm(`Smazat index ${index.name}? Raw zprávy zůstanou zachované.`)) return;
    await pendingAction({
      key: `delete-index:${index.embedding_index_id}`, control: button,
      pendingText: "Mažu…",
      execute: () => window.chatContext.deleteEmbeddingIndex(index.embedding_index_id),
      commit: () => updateSettings((state) => ({ ...state, embeddings: {
        ...state.embeddings,
        indexes: state.embeddings.indexes.filter(
          (item) => item.embedding_index_id !== index.embedding_index_id,
        ),
      } })),
      successMessage: "Index byl smazán.", databaseChanged: true,
    });
  }

  async function updateAutoSync(index, checkbox) {
    await optimisticIndexUpdate({
      key: `auto-sync:${index.embedding_index_id}`, control: checkbox,
      project: (state) => updateIndex(state, index.embedding_index_id, {
        auto_sync: checkbox.checked,
      }),
      execute: () => window.chatContext.updateEmbeddingIndex(
        index.embedding_index_id, { auto_sync: checkbox.checked },
      ),
      successMessage: "Auto-sync byl změněn.",
    });
  }

  function optimisticIndexUpdate(options) {
    return window.settingsMutationUi.run({
      ...options,
      apply: () => updateSettings(options.project),
      rollback: (snapshot) => updateSettings(() => snapshot),
      databaseChanged: () => window.overviewController.markDatabaseChanged(),
    });
  }

  function pendingAction(options) {
    return window.settingsMutationUi.run({
      ...options,
      databaseChanged: options.databaseChanged
        ? () => window.overviewController.markDatabaseChanged() : undefined,
    });
  }

  function updateIndex(state, indexId, updates) {
    return { ...state, embeddings: {
      ...state.embeddings,
      indexes: state.embeddings.indexes.map((index) => (
        index.embedding_index_id === indexId ? { ...index, ...updates } : index
      )),
    } };
  }

  return { bind, removeProvider, activateIndex, syncIndex, rebuildIndex, removeIndex, updateAutoSync };
})();
