const conversationHistory = [];
let showChatScreen = () => {};
let showChatToast = () => {};

function bindChatController(dependencies) {
  showChatScreen = dependencies.showScreen;
  showChatToast = dependencies.showToast;
}

async function openChatScreen() {
  await window.chatContext.hideDiscord();
  showChatScreen("chat");
  try {
    await Promise.all([
      window.chatScopeSelector.refresh(), window.settingsUi.prepareChat(),
    ]);
  } catch (error) {
    showChatToast(error.message, true);
  }
}

async function submitChatQuestion(event) {
  event.preventDefault();
  const input = document.querySelector("#question-input");
  const question = input.value.trim();
  if (!question) return;
  const requestHistory = conversationHistory.slice(-8);
  appendConversationEntry("user", question);
  conversationHistory.push({ role: "user", content: question });
  input.value = "";
  try {
    const scope = window.chatScopeSelector.getSelectedScope();
    const chatSelection = window.settingsUi.getChatSelection();
    const response = await window.chatContext.askDatabase(
      question, requestHistory, scope, chatSelection,
    );
    appendConversationEntry("assistant", response.answer, response.sources);
    conversationHistory.push({ role: "assistant", content: response.answer });
  } catch (error) {
    showChatToast(error.message, true);
  }
}

function appendConversationEntry(role, text, sources = []) {
  const conversation = document.querySelector("#conversation");
  conversation.querySelector(".empty-chat")?.remove();
  const entry = document.createElement("div");
  entry.className = `chat-bubble ${role}`;
  entry.textContent = text;
  const sourceCards = role === "assistant"
    ? window.chatSources.createChatSources(sources)
    : null;
  conversation.append(...[entry, sourceCards].filter(Boolean));
  conversation.scrollTop = conversation.scrollHeight;
}

function resetConversation(scopeLabel) {
  conversationHistory.length = 0;
  const emptyChat = document.createElement("div");
  emptyChat.className = "empty-chat";
  const icon = document.createElement("span");
  icon.textContent = "✦";
  const prompt = document.createElement("p");
  prompt.textContent = `Nový chat nad ${scopeLabel}. Položte první otázku.`;
  emptyChat.append(icon, prompt);
  document.querySelector("#conversation").replaceChildren(emptyChat);
}

window.chatController = {
  bind: bindChatController,
  open: openChatScreen,
  resetConversation,
  submitQuestion: submitChatQuestion,
};
