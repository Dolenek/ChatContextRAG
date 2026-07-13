const conversationHistory = [];
let showChatToast = () => {};

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
  const input = document.querySelector("#question-input");
  const submitButton = document.querySelector("#chat-form button[type='submit']");
  const question = input.value.trim();
  if (!question) return;
  const requestHistory = conversationHistory.slice(-8);
  appendConversationEntry("user", question);
  conversationHistory.push({ role: "user", content: question });
  input.value = "";
  submitButton.disabled = true;
  try {
    const scope = window.chatScopeSelector.getSelectedScope();
    const chatSelection = window.modelSelector.getChatSelection();
    const response = await window.chatContext.askDatabase(
      question, requestHistory, scope, chatSelection,
    );
    appendConversationEntry("assistant", response.answer, response.sources);
    conversationHistory.push({ role: "assistant", content: response.answer });
    window.contextPanel.showSources(response.sources || []);
    window.shellController.openContext();
  } catch (error) {
    showChatToast(error.message, true);
  } finally {
    submitButton.disabled = false;
    input.focus();
  }
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

function resetConversation(scopeLabel) {
  conversationHistory.length = 0;
  window.contextPanel.clear();
  const emptyChat = document.createElement("div");
  const icon = document.createElement("span");
  const heading = document.createElement("h2");
  const prompt = document.createElement("p");
  emptyChat.className = "empty-chat";
  icon.textContent = "✦";
  heading.textContent = "Nový chat";
  prompt.textContent = `Položte první otázku nad ${scopeLabel.toLowerCase()}.`;
  emptyChat.append(icon, heading, prompt);
  document.querySelector("#conversation").replaceChildren(emptyChat);
}

function startNewChat() {
  const selectedOption = document.querySelector("#chat-scope-select").selectedOptions[0];
  resetConversation(selectedOption?.textContent.split(" · ")[0] || "všemi zprávami");
  document.querySelector("#question-input").focus();
}

window.chatController = {
  bind: bindChatController,
  open: openChatScreen,
  resetConversation,
  startNewChat,
  submitQuestion: submitChatQuestion,
};
