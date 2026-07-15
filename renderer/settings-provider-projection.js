window.settingsProviderProjection = (() => {
  let getState = () => null;
  let updateSettings = () => {};
  let resetForm = () => {};

  function bind(dependencies) {
    getState = dependencies.getState;
    updateSettings = dependencies.updateSettings;
    resetForm = dependencies.resetForm;
  }

  function readForm() {
    return {
      providerId: value("#provider-id") || undefined,
      name: value("#provider-name"), baseUrl: value("#provider-base-url"),
      apiKey: value("#provider-api-key"), chatApi: value("#provider-chat-api"),
    };
  }

  function projectPending(input) {
    const currentState = getState();
    const projectedId = input.providerId || `pending-provider-${Date.now()}`;
    const current = currentState.providers.find(
      (provider) => provider.provider_id === input.providerId,
    );
    const projected = {
      ...(current || {}), provider_id: projectedId, name: input.name,
      base_url: input.baseUrl, chat_api: input.chatApi, _pending: true,
    };
    updateSettings((state) => ({ ...state, providers: [
      ...state.providers.filter((provider) => provider.provider_id !== projectedId),
      projected,
    ] }));
    resetForm();
    return { originalState: currentState, input, projectedId };
  }

  function commit(savedProvider, snapshot) {
    updateSettings((state) => ({ ...state, providers: [
      ...state.providers.filter(
        (provider) => provider.provider_id !== snapshot.projectedId
          && provider.provider_id !== savedProvider.provider_id,
      ),
      savedProvider,
    ] }));
  }

  function rollback(snapshot) {
    updateSettings(() => snapshot.originalState);
    const fields = {
      "#provider-id": snapshot.input.providerId || "", "#provider-name": snapshot.input.name,
      "#provider-base-url": snapshot.input.baseUrl,
      "#provider-api-key": snapshot.input.apiKey, "#provider-chat-api": snapshot.input.chatApi,
    };
    Object.entries(fields).forEach(([selector, fieldValue]) => {
      document.querySelector(selector).value = fieldValue;
    });
    document.querySelector("#provider-name").focus();
  }

  function value(selector) {
    return document.querySelector(selector).value;
  }

  return { bind, readForm, projectPending, commit, rollback };
})();
