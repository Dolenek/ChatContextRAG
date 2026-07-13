let indexingKeySettings = null;
let refreshAllSettings = async () => {};
let showIndexingKeyToast = () => {};

function bindIndexingApiKeyUi(dependencies) {
  refreshAllSettings = dependencies.refreshSettings;
  showIndexingKeyToast = dependencies.showToast;
  document.querySelector("#indexing-api-key-form").addEventListener(
    "submit", saveIndexingApiKey,
  );
}

function renderIndexingApiKeyUi(settings) {
  indexingKeySettings = settings;
  const select = document.querySelector("#indexing-key-provider");
  const previous = select.value;
  const activeIndex = settings.embeddings.indexes.find(
    (index) => index.embedding_index_id === settings.embeddings.active_embedding_index_id,
  );
  select.replaceChildren(...settings.providers.map(providerOption));
  const preferred = previous || activeIndex?.provider_id;
  if ([...select.options].some((option) => option.value === preferred)) {
    select.value = preferred;
  }
}

function providerOption(provider) {
  const option = document.createElement("option");
  option.value = provider.provider_id;
  option.textContent = provider.has_api_key
    ? `${provider.name} (klíč uložen)` : provider.name;
  return option;
}

async function saveIndexingApiKey(submitEvent) {
  submitEvent.preventDefault();
  const providerId = document.querySelector("#indexing-key-provider").value;
  const provider = indexingKeySettings.providers.find(
    (item) => item.provider_id === providerId,
  );
  if (!provider) {
    showIndexingKeyToast("Vybraný provider neexistuje.", true);
    return;
  }
  try {
    await window.chatContext.saveProvider(providerKeyInput(provider));
    document.querySelector("#indexing-api-key").value = "";
    await refreshAllSettings();
    showIndexingKeyToast(
      `API klíč pro ${provider.name} byl uložen pro chat i indexing.`,
    );
  } catch (error) { showIndexingKeyToast(error.message, true); }
}

function providerKeyInput(provider) {
  return {
    providerId: provider.provider_id,
    name: provider.name,
    baseUrl: provider.base_url,
    apiKey: document.querySelector("#indexing-api-key").value,
    chatApi: provider.chat_api,
  };
}

function selectIndexingProvider(providerId) {
  document.querySelector("#indexing-key-provider").value = providerId;
  document.querySelector("#indexing-api-key").focus();
  document.querySelector("#indexing-api-key-form").scrollIntoView({
    behavior: "smooth", block: "center",
  });
}

window.indexingApiKeyUi = {
  bind: bindIndexingApiKeyUi,
  render: renderIndexingApiKeyUi,
  select: selectIndexingProvider,
};
