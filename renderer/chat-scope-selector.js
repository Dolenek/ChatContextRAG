const chatScopeSelect = document.querySelector("#chat-scope-select");
const chatScopeStatus = document.querySelector("#chat-scope-status");
const availableChatScopes = new Map();
let scopeChangeListener = () => {};

async function refreshChatScopes() {
  const previousKey = chatScopeSelect.value;
  setScopeLoading(true);
  try {
    const response = await window.chatContext.getChatScopes();
    renderChatScopes(response.scopes || [], previousKey);
  } finally {
    setScopeLoading(false);
  }
}

function renderChatScopes(scopes, preferredKey) {
  availableChatScopes.clear();
  const allOption = new Option("Všechny uložené zprávy", "");
  const sourceGroups = groupScopesBySource(scopes);
  const groupElements = [...sourceGroups.entries()].map(createSourceGroup);
  chatScopeSelect.replaceChildren(allOption, ...groupElements);
  chatScopeSelect.value = availableChatScopes.has(preferredKey) ? preferredKey : "";
  chatScopeStatus.textContent = scopes.length
    ? `${scopes.length} dostupných konverzací`
    : "Zatím není dostupná žádná zaindexovaná konverzace";
}

function groupScopesBySource(scopes) {
  return scopes.reduce((groups, scope) => {
    const sourceScopes = groups.get(scope.source_type) || [];
    sourceScopes.push(scope);
    groups.set(scope.source_type, sourceScopes);
    return groups;
  }, new Map());
}

function createSourceGroup([sourceType, scopes]) {
  const group = document.createElement("optgroup");
  group.label = sourceDisplayName(sourceType);
  group.append(...scopes.map(createScopeOption));
  return group;
}

function createScopeOption(scope) {
  const key = `${scope.source_type}:${scope.conversation_id}`;
  availableChatScopes.set(key, scope);
  const messageSuffix = scope.message_count === 1 ? "zpráva" : "zpráv";
  return new Option(`${scope.display_name} · ${scope.message_count} ${messageSuffix}`, key);
}

function sourceDisplayName(sourceType) {
  if (sourceType === "discord") return "Discord kanály";
  if (sourceType === "whatsapp") return "WhatsApp konverzace";
  return sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
}

function getSelectedScope() {
  const selected = availableChatScopes.get(chatScopeSelect.value);
  if (!selected) return null;
  return { source_type: selected.source_type, conversation_id: selected.conversation_id };
}

function selectedScopeLabel() {
  return availableChatScopes.get(chatScopeSelect.value)?.display_name
    || "všemi uloženými zprávami";
}

function setScopeLoading(isLoading) {
  chatScopeSelect.disabled = isLoading;
  if (isLoading) chatScopeStatus.textContent = "Načítám konverzace…";
}

chatScopeSelect.addEventListener("change", () => {
  scopeChangeListener(selectedScopeLabel());
});

window.chatScopeSelector = {
  bind: (listener) => { scopeChangeListener = listener; },
  getSelectedScope,
  refresh: refreshChatScopes,
};
