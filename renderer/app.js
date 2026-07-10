const screens = {
  home: document.querySelector("#home-screen"),
  result: document.querySelector("#result-screen"),
  chat: document.querySelector("#chat-screen"),
};
const discordActions = document.querySelector("#discord-actions");
const toast = document.querySelector("#toast");
const conversationHistory = [];

function showScreen(screenName) {
  Object.entries(screens).forEach(([name, element]) => {
    element.classList.toggle("hidden", name !== screenName);
  });
  discordActions.classList.add("hidden");
}

async function openDiscord() {
  showScreen("home");
  discordActions.classList.remove("hidden");
  try {
    await window.chatContext.openDiscord();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function captureDiscordMessages() {
  setCaptureBusy(true);
  try {
    const result = await window.chatContext.captureDiscord();
    renderImportedMessages(result);
    showScreen("result");
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setCaptureBusy(false);
  }
}

function setCaptureBusy(isBusy) {
  const button = document.querySelector("#capture-button");
  button.disabled = isBusy;
  button.textContent = isBusy ? "Načítám…" : "Načíst poslední 4";
}

function renderImportedMessages(result) {
  document.querySelector("#import-summary").textContent =
    `Zpracováno: ${result.imported_count} zpráv · Uloženo: ${result.chunk_count} chunků`;
  const list = document.querySelector("#message-list");
  list.replaceChildren(...result.messages.map(createMessageCard));
}

function createMessageCard(message) {
  const card = document.createElement("article");
  card.className = "message-card";
  const initials = message.author.slice(0, 2).toUpperCase();
  const timestamp = message.timestamp ? new Date(message.timestamp).toLocaleString("cs-CZ") : "Bez času";
  card.innerHTML = `<div class="avatar">${escapeHtml(initials)}</div><div><div class="message-meta"><strong>${escapeHtml(message.author)}</strong><span>${escapeHtml(timestamp)}</span></div><p>${escapeHtml(message.content)}</p></div>`;
  return card;
}

async function submitQuestion(event) {
  event.preventDefault();
  const input = document.querySelector("#question-input");
  const question = input.value.trim();
  if (!question) return;
  const requestHistory = conversationHistory.slice(-8);
  appendConversationEntry("user", question);
  conversationHistory.push({ role: "user", content: question });
  input.value = "";
  try {
    const response = await window.chatContext.askDatabase(question, requestHistory);
    appendConversationEntry("assistant", response.answer);
    conversationHistory.push({ role: "assistant", content: response.answer });
  } catch (error) {
    showToast(error.message, true);
  }
}

function appendConversationEntry(role, text) {
  const conversation = document.querySelector("#conversation");
  conversation.querySelector(".empty-chat")?.remove();
  const entry = document.createElement("div");
  entry.className = `chat-bubble ${role}`;
  entry.textContent = text;
  conversation.append(entry);
  conversation.scrollTop = conversation.scrollHeight;
}

function showToast(message, isError = false) {
  toast.textContent = message;
  toast.classList.toggle("error", isError);
  toast.classList.remove("hidden");
  window.setTimeout(() => toast.classList.add("hidden"), 4500);
}

function escapeHtml(value) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;",
  })[character]);
}

document.querySelector("#open-discord-button").addEventListener("click", openDiscord);
document.querySelector("#capture-button").addEventListener("click", captureDiscordMessages);
document.querySelector("#open-chat-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#chat-after-import-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#import-more-button").addEventListener("click", openDiscord);
document.querySelector("#chat-form").addEventListener("submit", submitQuestion);
document.querySelector("#home-button").addEventListener("click", async () => {
  await window.chatContext.hideDiscord();
  showScreen("home");
});
