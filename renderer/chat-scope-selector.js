const chatScopeSelect = document.querySelector("#chat-scope-select");
const chatScopeStatus = document.querySelector("#chat-scope-status");
const chatScopeList = document.querySelector("#chat-scope-list");
const availableChatScopes = new Map();
let unavailableRestoredScope = null;
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
  chatScopeSelect.replaceChildren(
    allOption,
    ...[...sourceGroups.entries()].map(createSourceGroup),
  );
  preserveUnavailableScope(preferredKey);
  const selectedKey = availableChatScopes.has(preferredKey) ? preferredKey : "";
  chatScopeSelect.value = selectedKey;
  renderScopeButtons(scopes, selectedKey);
  updateActiveScopeLabel();
  chatScopeStatus.textContent = scopes.length
    ? `${scopes.length} dostupných konverzací`
    : "Zatím není dostupná žádná zaindexovaná konverzace";
}

function preserveUnavailableScope(preferredKey) {
  if (!unavailableRestoredScope || scopeKey(unavailableRestoredScope) !== preferredKey) return;
  if (availableChatScopes.has(preferredKey)) {
    unavailableRestoredScope = null;
    return;
  }
  addUnavailableScope(preferredKey, unavailableRestoredScope);
}

function groupScopesBySource(scopes) {
  return scopes.reduce((groups, scope) => {
    const sourceType = scope.source_type || "other";
    if (!groups.has(sourceType)) groups.set(sourceType, []);
    groups.get(sourceType).push(scope);
    return groups;
  }, new Map());
}

function createSourceGroup([sourceType, scopes]) {
  const group = document.createElement("optgroup");
  group.label = sourceLabel(sourceType);
  scopes.forEach((scope) => {
    const key = scopeKey(scope);
    availableChatScopes.set(key, scope);
    const context = scope.container_name ? `${scope.container_name} / ` : "";
    group.append(new Option(
      `${context}${scope.display_name} · ${scope.message_count} zpráv`, key,
    ));
  });
  return group;
}

function renderScopeButtons(scopes, selectedKey) {
  const buttons = [createScopeButton(null, "", selectedKey)];
  scopes.forEach((scope) => buttons.push(createScopeButton(scope, scopeKey(scope), selectedKey)));
  chatScopeList.replaceChildren(...buttons);
}

function createScopeButton(scope, key, selectedKey) {
  const button = document.createElement("button");
  const icon = document.createElement("span");
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  const count = document.createElement("span");
  button.className = "scope-item";
  button.type = "button";
  button.classList.toggle("active", key === selectedKey);
  button.dataset.scopeKey = key;
  icon.className = "scope-icon";
  copy.className = "scope-copy";
  count.className = "scope-count";
  icon.textContent = scope ? sourceShortLabel(scope.source_type) : "✦";
  title.textContent = scope?.display_name || "Všechny zprávy";
  detail.textContent = scope?.container_name || (scope ? sourceLabel(scope.source_type) : "Celá databáze");
  count.textContent = scope ? formatCount(scope.message_count) : "";
  copy.append(title, detail);
  button.append(icon, copy, count);
  button.addEventListener("click", () => selectScope(key));
  return button;
}

function selectScope(key) {
  if (chatScopeSelect.value === key) return;
  chatScopeSelect.value = key;
  chatScopeSelect.dispatchEvent(new Event("change"));
}

function handleScopeChange() {
  if (!availableChatScopes.get(chatScopeSelect.value)?.unavailable) {
    unavailableRestoredScope = null;
  }
  document.querySelectorAll(".scope-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.scopeKey === chatScopeSelect.value);
  });
  updateActiveScopeLabel();
  scopeChangeListener(selectedScopeLabel());
}

function updateActiveScopeLabel() {
  document.querySelector("#active-scope-label").textContent = selectedScopeLabel().toLowerCase();
}

function selectedScopeLabel() {
  return availableChatScopes.get(chatScopeSelect.value)?.display_name
    || "Všechny uložené zprávy";
}

function getSelectedScope() {
  const selected = availableChatScopes.get(chatScopeSelect.value);
  return selected ? {
    source_type: selected.source_type,
    conversation_id: selected.conversation_id,
  } : null;
}

function restoreScope(scope) {
  if (!scope) {
    chatScopeSelect.value = "";
    updateRestoredScopeUi();
    return true;
  }
  const key = scopeKey(scope);
  const selectedScope = availableChatScopes.get(key);
  const isAvailable = Boolean(selectedScope && !selectedScope.unavailable);
  unavailableRestoredScope = isAvailable ? null : scope;
  if (!isAvailable) addUnavailableScope(key, scope);
  chatScopeSelect.value = key;
  updateRestoredScopeUi();
  return isAvailable;
}

function addUnavailableScope(key, scope) {
  const label = `${scope.conversation_id} (nedostupný zdroj)`;
  availableChatScopes.set(key, {
    ...scope, display_name: label, message_count: 0, unavailable: true,
  });
  chatScopeSelect.append(new Option(label, key));
}

function updateRestoredScopeUi() {
  document.querySelectorAll(".scope-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.scopeKey === chatScopeSelect.value);
  });
  updateActiveScopeLabel();
}

function setScopeLoading(isLoading) {
  chatScopeSelect.disabled = isLoading;
  if (isLoading) chatScopeStatus.textContent = "Načítám konverzace…";
}

function sourceLabel(sourceType) {
  if (sourceType === "discord") return "Discord";
  if (sourceType === "whatsapp") return "WhatsApp";
  return "Ostatní zdroje";
}

function sourceShortLabel(sourceType) {
  if (sourceType === "discord") return "D";
  if (sourceType === "whatsapp") return "W";
  return "?";
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("cs-CZ");
}

function scopeKey(scope) {
  return `${scope.source_type}:${scope.conversation_id}`;
}

chatScopeSelect.addEventListener("change", handleScopeChange);
window.chatScopeSelector = {
  bind: (listener) => { scopeChangeListener = listener; },
  getSelectedScope,
  refresh: refreshChatScopes,
  restoreScope,
};
