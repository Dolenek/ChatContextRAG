window.interactionCoordinator = (() => {
  const latestRequestRevisions = new Map();
  const pendingMutations = new Map();

  async function runLatest(key, execute, apply) {
    const revision = supersede(key);
    try {
      const result = await execute();
      if (!isLatest(key, revision)) return { status: "stale" };
      if (apply) await apply(result);
      return { status: "applied", result };
    } catch (error) {
      if (!isLatest(key, revision)) return { status: "stale" };
      throw error;
    }
  }

  function runMutation(options) {
    const existing = pendingMutations.get(options.key);
    if (existing) return existing;
    const mutationPromise = performMutation(options).finally(() => {
      if (pendingMutations.get(options.key) === mutationPromise) {
        pendingMutations.delete(options.key);
      }
    });
    pendingMutations.set(options.key, mutationPromise);
    return mutationPromise;
  }

  async function performMutation(options) {
    const controlSnapshots = captureControls(options.controls);
    let restoreControls = () => {};
    let snapshot;
    try {
      snapshot = options.apply?.();
      restoreControls = markControlsPending(controlSnapshots, options.controls);
      const result = await options.execute();
      options.commit?.(result, snapshot);
      reconcileInBackground(options);
      return result;
    } catch (error) {
      options.rollback?.(snapshot, error);
      throw error;
    } finally {
      restoreControls();
    }
  }

  function reconcileInBackground(options) {
    if (!options.reconcile) return;
    Promise.resolve().then(options.reconcile).catch((error) => {
      options.reconcileFailed?.(error);
    });
  }

  function captureControls(controls = []) {
    return controls.filter((control) => control?.element).map((control) => ({
      element: control.element, snapshot: controlSnapshot(control.element),
    }));
  }

  function markControlsPending(snapshots, controls = []) {
    snapshots.forEach(({ element }, index) => {
      const control = controls.filter((item) => item?.element)[index];
      element.disabled = true;
      element.setAttribute?.("aria-busy", "true");
      element.classList?.add("mutation-pending");
      if (control.pendingText) element.textContent = control.pendingText;
    });
    return () => snapshots.forEach(restoreControl);
  }

  function controlSnapshot(element) {
    return {
      disabled: Boolean(element.disabled), textContent: element.textContent,
      ariaBusy: element.getAttribute?.("aria-busy") ?? null,
    };
  }

  function restoreControl({ element, snapshot }) {
    element.disabled = snapshot.disabled;
    element.textContent = snapshot.textContent;
    element.classList?.remove("mutation-pending");
    if (snapshot.ariaBusy === null) element.removeAttribute?.("aria-busy");
    else element.setAttribute?.("aria-busy", snapshot.ariaBusy);
  }

  function supersede(key) {
    const revision = (latestRequestRevisions.get(key) || 0) + 1;
    latestRequestRevisions.set(key, revision);
    return revision;
  }

  function isLatest(key, revision) {
    return latestRequestRevisions.get(key) === revision;
  }

  return {
    isPending: (key) => pendingMutations.has(key),
    runLatest, runMutation, supersede,
  };
})();
