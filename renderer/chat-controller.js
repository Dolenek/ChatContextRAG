const conversationHistory = [];
let showChatToast = () => {};
let activeSessionId = null;
let readOnlyReason = "";

function bindChatController(dependencies) {
  showChatToast = dependencies.showToast;
}

async function openChatScreen() {
  await window.chatContext.hideDiscord();
  window.shellController.setDiscordActive(false);
  window.shellController.showScreen("chat");
  window.shellController.closeDrawer();
  try {
    await Promise.all([
      window.chatScopeSelector.refresh(),
      window.modelSelector.prepare(),
    ]);
  } catch (error) {
    showChatToast(error.message, true);
  }
}

async function submitChatQuestion(event) {
  event.preventDefault();
  if (readOnlyReason) return;
  const input = document.querySelector("#question-input");
  const question = input.value.trim();
  if (!question) return;
  const requestHistory = conversationHistory.slice(-8);
  const userEntry = window.conversationView.appendUser(question);
  const thinkingEntry = window.conversationView.appendThinking();
  conversationHistory.push({ role: "user", content: question });
  window.conversationView.resetComposer();
  setSubmitting(true);
  try {
    await requestAnswer(question, requestHistory, userEntry, thinkingEntry);
  } catch (error) {
    window.conversationView.removeThinking(thinkingEntry);
    window.conversationView.markFailed(userEntry);
    showChatToast(error.message, true);
  } finally {
    setSubmitting(false);
    input.focus();
  }
}

async function requestAnswer(question, requestHistory, userEntry, thinkingEntry) {
  const scope = window.chatScopeSelector.getSelectedScope();
  const chatSelection = {
    ...window.modelSelector.getChatSelection(),
    ...window.retrievalModeSelector.getSelection(),
  };
  const request = chatSelection.retrievalMode === "adaptive"
    ? window.chatContext.askDatabaseStreaming : window.chatContext.askDatabase;
  const response = await request(
    question, requestHistory, scope, chatSelection, activeSessionId,
    (record) => window.conversationView.updateThinking(thinkingEntry, record),
  );
  window.conversationView.markPersisted(userEntry);
  window.conversationView.replaceThinking(
    thinkingEntry, response.answer, response.sources || [], response.tool_activity || [],
  );
  conversationHistory.push({ role: "assistant", content: response.answer });
  activeSessionId = response.chat_session_id || null;
  window.contextPanel.showSources(response.sources || []);
  window.shellController.openContext();
  await window.chatHistoryUi?.responseSaved?.(response);
}

function setSubmitting(isSubmitting) {
  const submit = document.querySelector("#chat-form button[type='submit']");
  submit.disabled = isSubmitting;
  if (!isSubmitting) window.modelSelector.updateAvailability?.();
}

function resetConversation(scopeLabel = currentScopeLabel()) {
  conversationHistory.length = 0;
  activeSessionId = null;
  setReadOnly("");
  window.contextPanel.clear();
  window.chatHistoryUi?.setActiveSession?.(null);
  window.conversationView.reset(scopeLabel);
}

function startNewChat() {
  window.modelSelector.releaseSessionSelection();
  window.shellController.showScreen("chat");
  window.shellController.closeDrawer();
  resetConversation();
  document.querySelector("#question-input").focus();
}

async function restoreSession(sessionId) {
  await window.chatContext.hideDiscord();
  window.shellController.setDiscordActive(false);
  window.shellController.showScreen("chat");
  window.shellController.closeDrawer();
  try {
    const [session] = await Promise.all([
      window.chatContext.getChatSession(sessionId),
      window.chatScopeSelector.refresh(),
      window.modelSelector.prepare(),
    ]);
    applyRestoredSession(session);
  } catch (error) {
    showChatToast(error.message, true);
  }
}

function applyRestoredSession(session) {
  const sourceAvailable = window.chatScopeSelector.restoreScope(session.scope);
  const modelAvailable = window.modelSelector.restoreSelection(
    session.chat_provider_id, session.chat_model, session.reasoning_effort,
  );
  const retrievalAvailable = window.retrievalModeSelector.restore(
    session.retrieval_mode, session.evidence_character_limit,
  );
  conversationHistory.splice(
    0, conversationHistory.length,
    ...session.messages.map(({ role, content }) => ({ role, content })),
  );
  renderRestoredMessages(session.messages);
  activeSessionId = session.session_id;
  window.chatHistoryUi.setActiveSession(activeSessionId);
  setReadOnly(restoredSessionBlockReason(
    sourceAvailable, modelAvailable, retrievalAvailable,
  ));
}

function renderRestoredMessages(messages) {
  window.conversationView.renderMessages(messages);
  window.contextPanel.clear();
}

function restoredSessionBlockReason(sourceAvailable, modelAvailable, retrievalAvailable) {
  const missing = [];
  if (!sourceAvailable) missing.push("původní zdroj");
  if (!modelAvailable) missing.push("původní model");
  if (!retrievalAvailable) missing.push("původní adaptivní režim");
  if (!missing.length) return "";
  return `Původní kontext už není dostupný (${missing.join(" a ")}). `
    + "Chat zůstává jen pro čtení; "
    + "výběrem jiného zdroje nebo modelu založíte nový chat.";
}

function setReadOnly(reason) {
  readOnlyReason = reason;
  const notice = document.querySelector("#chat-readonly-notice");
  notice.textContent = reason;
  notice.classList.toggle("hidden", !reason);
  document.querySelector("#question-input").disabled = Boolean(reason);
  window.modelSelector.updateAvailability?.();
}

function currentScopeLabel() {
  const selected = document.querySelector("#chat-scope-select").selectedOptions[0];
  return selected?.textContent.split(" · ")[0] || "všemi zprávami";
}

window.chatController = {
  bind: bindChatController,
  isReadOnly: () => Boolean(readOnlyReason),
  open: openChatScreen,
  resetConversation,
  restoreSession,
  startNewChat,
  submitQuestion: submitChatQuestion,
};
