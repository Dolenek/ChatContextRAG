window.settingsMutationUi = (() => {
  let reconcile = async () => {};
  let showToast = () => {};

  function bind(dependencies) {
    reconcile = dependencies.reconcile;
    showToast = dependencies.showToast;
  }

  async function run(options) {
    try {
      return await window.interactionCoordinator.runMutation({
        key: options.key,
        controls: options.control ? [{
          element: options.control, pendingText: options.pendingText,
        }] : [],
        apply: options.apply,
        execute: options.execute,
        commit: (result, snapshot) => {
          options.commit?.(result, snapshot);
          options.databaseChanged?.();
          if (options.successMessage) showToast(
            typeof options.successMessage === "function"
              ? options.successMessage(result) : options.successMessage,
          );
        },
        rollback: options.rollback,
        reconcile,
        reconcileFailed,
      });
    } catch (error) {
      showToast(error.message, true);
      return null;
    }
  }

  function reconcileFailed(error) {
    window.workspaceCache.invalidate("settings");
    showToast(`Změna je uložená, ale obnovení selhalo: ${error.message}`, true);
  }

  return { bind, run };
})();
