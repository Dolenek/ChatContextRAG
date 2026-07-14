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
  appendConversationEntry("user", question);
  conversationHistory.push({ role: "user", content: question });
  input.value = "";
  setSubmitting(true);
  try {
    await requestAnswer(question, requestHistory);
  } catch (error) {
    showChatToast(error.message, true);
  } finally {
    setSubmitting(false);
    input.focus();
  }
}

async function requestAnswer(question, requestHistory) {
  const scope = window.chatScopeSelector.getSelectedScope();
  const chatSelection = window.modelSelector.getChatSelection();
  const response = await window.chatContext.askDatabase(
    question, requestHistory, scope, chatSelection, activeSessionId,
  );
  appendConversationEntry("assistant", response.answer, response.sources);
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

function appendConversationEntry(role, text, sources = []) {
  const conversation = document.querySelector("#conversation");
  conversation.querySelector(".empty-chat")?.remove();
  const entry = document.createElement("article");
  const bubble = document.createElement("div");
  entry.className = `conversation-entry ${role}`;
  bubble.className = "chat-bubble";
  bubble.textContent = text;
  entry.append(bubble);
  if (role === "assistant" && sources.length) entry.append(createAssistantFooter(sources));
  conversation.append(entry);
  conversation.scrollTop = conversation.scrollHeight;
}

function createAssistantFooter(sources) {
  const footer = document.createElement("div");
  const button = document.createElement("button");
  footer.className = "assistant-footer";
  button.className = "source-recall-button";
  button.type = "button";
  button.textContent = `Zdroje (${sources.length})`;
  button.addEventListener("click", () => {
    window.contextPanel.showSources(sources);
    window.shellController.openContext();
  });
  footer.append(button);
  return footer;
}

function resetConversation(scopeLabel = currentScopeLabel()) {
  conversationHistory.length = 0;
  activeSessionId = null;
  setReadOnly("");
  window.contextPanel.clear();
  window.chatHistoryUi?.setActiveSession?.(null);
  document.querySelector("#conversation").replaceChildren(createEmptyChat(scopeLabel));
}

function createEmptyChat(scopeLabel) {
  const emptyChat = document.createElement("div");
  const icon = document.createElement("span");
  const heading = document.createElement("h2");
  const prompt = document.createElement("p");
  emptyChat.className = "empty-chat";
  icon.textContent = "✦";
  heading.textContent = "Nový chat";
  prompt.textContent = `Položte první otázku nad ${scopeLabel.toLowerCase()}.`;
  emptyChat.append(icon, heading, prompt);
  return emptyChat;
}

function startNewChat() {
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
  conversationHistory.splice(
    0, conversationHistory.length,
    ...session.messages.map(({ role, content }) => ({ role, content })),
  );
  renderRestoredMessages(session.messages);
  activeSessionId = session.session_id;
  window.chatHistoryUi.setActiveSession(activeSessionId);
  setReadOnly(restoredSessionBlockReason(sourceAvailable, modelAvailable));
}

function renderRestoredMessages(messages) {
  const conversation = document.querySelector("#conversation");
  conversation.replaceChildren();
  messages.forEach((message) => {
    appendConversationEntry(message.role, message.content, message.sources || []);
  });
  window.contextPanel.clear();
}

function restoredSessionBlockReason(sourceAvailable, modelAvailable) {
  const missing = [];
  if (!sourceAvailable) missing.push("původní zdroj");
  if (!modelAvailable) missing.push("původní model");
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
