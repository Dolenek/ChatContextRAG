const screens = {
  home: document.querySelector("#home-screen"),
  result: document.querySelector("#result-screen"),
  chat: document.querySelector("#chat-screen"),
  overview: document.querySelector("#overview-screen"),
};
const discordActions = document.querySelector("#discord-actions");
const toast = document.querySelector("#toast");
const conversationHistory = [];
const overviewPageSize = 50;
let overviewOffset = 0;
let channelScanRunning = false;

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

async function toggleChannelScan() {
  if (channelScanRunning) {
    document.querySelector("#scan-progress").textContent = "Zastavuji procházení…";
    await window.chatContext.stopDiscordScan();
    return;
  }
  channelScanRunning = true;
  updateScanButton();
  try {
    const summary = await window.chatContext.startDiscordScan();
    showToast(scanCompletionMessage(summary));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    channelScanRunning = false;
    updateScanButton();
  }
}

function renderScanProgress(progress) {
  const status = document.querySelector("#scan-progress");
  const waitingStates = ["waiting", "retrying", "waiting-channel"];
  const suffix = waitingStates.includes(progress.state)
    ? ` · čekám a zkouším dál${progress.lastError ? `: ${progress.lastError}` : "…"}`
    : "";
  status.textContent = `Nalezeno ${progress.discoveredMessages} · nově uloženo ${progress.importedMessages} · chunky ${progress.storedChunks}${suffix}`;
}

function updateScanButton() {
  const button = document.querySelector("#scan-channel-button");
  button.textContent = channelScanRunning ? "Zastavit" : "Procházet do databáze";
  button.classList.toggle("scanning", channelScanRunning);
  document.querySelector("#capture-button").disabled = channelScanRunning;
}

function scanCompletionMessage(summary) {
  const prefix = summary.state === "completed" ? "Kanál byl projit až na začátek." : "Procházení skončilo.";
  return `${prefix} Nově uloženo ${summary.importedMessages} zpráv v ${summary.storedChunks} chunkech.`;
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

async function openDatabaseOverview() {
  await window.chatContext.hideDiscord();
  showScreen("overview");
  overviewOffset = 0;
  document.querySelector("#database-chunks").replaceChildren();
  await loadDatabaseOverview(false);
}

async function loadDatabaseOverview(append) {
  setOverviewBusy(true);
  try {
    const overview = await window.chatContext.getDatabaseOverview(
      overviewPageSize, overviewOffset,
    );
    renderOverview(overview, append);
    overviewOffset += overview.chunks.length;
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setOverviewBusy(false);
  }
}

function renderOverview(overview, append) {
  renderOverviewStats(overview);
  renderCountList("#channel-counts", overview.channels);
  renderCountList("#author-counts", overview.authors);
  renderCountList("#model-counts", overview.embedding_models);
  const chunkCards = overview.chunks.map(createDatabaseChunkCard);
  const chunkList = document.querySelector("#database-chunks");
  append ? chunkList.append(...chunkCards) : chunkList.replaceChildren(...chunkCards);
  document.querySelector("#chunk-range").textContent =
    `Zobrazeno ${overview.offset + overview.chunks.length} z ${overview.total_chunks}`;
  document.querySelector("#load-more-chunks-button").classList.toggle("hidden", !overview.has_more);
}

function renderOverviewStats(overview) {
  const stats = [
    ["Chunky", overview.total_chunks], ["Zdrojové zprávy", overview.total_source_messages],
    ["Kanály", overview.total_channels], ["Autoři", overview.total_authors],
    ["Nejstarší zpráva", formatDate(overview.oldest_message_at)],
    ["Nejnovější zpráva", formatDate(overview.newest_message_at)],
  ];
  const cards = stats.map(([label, value]) => createStatCard(label, value));
  document.querySelector("#overview-stats").replaceChildren(...cards);
}

function createStatCard(label, value) {
  const card = document.createElement("article");
  card.className = "stat-card";
  const valueElement = document.createElement("strong");
  const labelElement = document.createElement("span");
  valueElement.textContent = value ?? "—";
  labelElement.textContent = label;
  card.append(valueElement, labelElement);
  return card;
}

function renderCountList(selector, counts) {
  const entries = counts.map((item) => {
    const row = document.createElement("div");
    row.innerHTML = `<span>${escapeHtml(item.label)}</span><strong>${item.count}</strong>`;
    return row;
  });
  if (!entries.length) entries.push(createEmptyLabel("Zatím bez dat"));
  document.querySelector(selector).replaceChildren(...entries);
}

function createDatabaseChunkCard(chunk) {
  const card = document.createElement("article");
  card.className = "database-chunk-card";
  const header = document.createElement("div");
  header.className = "chunk-meta";
  header.textContent = `${chunk.channel || "Bez kanálu"} · ${chunk.authors.join(", ")} · ${formatDate(chunk.started_at)}`;
  const content = document.createElement("p");
  content.textContent = chunk.content;
  const footer = document.createElement("small");
  footer.textContent = `${chunk.embedding_model} · ${chunk.source_message_ids.length} zdrojových zpráv · ID ${chunk.chunk_id.slice(0, 12)}`;
  card.append(header, content, footer);
  return card;
}

function createEmptyLabel(text) {
  const label = document.createElement("span");
  label.className = "empty-label";
  label.textContent = text;
  return label;
}

function formatDate(value) {
  return value ? new Date(value).toLocaleString("cs-CZ") : "Bez času";
}

function setOverviewBusy(isBusy) {
  const refreshButton = document.querySelector("#refresh-overview-button");
  refreshButton.disabled = isBusy;
  refreshButton.textContent = isBusy ? "Načítám…" : "Obnovit";
}

function openClearDatabaseDialog() {
  const dialog = document.querySelector("#clear-database-dialog");
  const input = document.querySelector("#clear-confirmation-input");
  input.value = "";
  document.querySelector("#confirm-clear-button").disabled = true;
  dialog.classList.remove("hidden");
  input.focus();
}

function closeClearDatabaseDialog() {
  document.querySelector("#clear-database-dialog").classList.add("hidden");
}

function updateClearConfirmation() {
  const confirmation = document.querySelector("#clear-confirmation-input").value;
  document.querySelector("#confirm-clear-button").disabled = confirmation !== "VYMAZAT";
}

async function clearDatabase() {
  const confirmation = document.querySelector("#clear-confirmation-input").value;
  if (confirmation !== "VYMAZAT") return;
  const button = document.querySelector("#confirm-clear-button");
  button.disabled = true;
  button.textContent = "Mažu…";
  try {
    const result = await window.chatContext.clearDatabase(confirmation);
    closeClearDatabaseDialog();
    showToast(`Databáze byla vymazána. Odstraněno chunků: ${result.deleted_chunks}`);
    await openDatabaseOverview();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    button.textContent = "Trvale vymazat";
  }
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
document.querySelector("#scan-channel-button").addEventListener("click", toggleChannelScan);
document.querySelector("#open-chat-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#open-overview-button").addEventListener("click", openDatabaseOverview);
document.querySelector("#chat-after-import-button").addEventListener("click", () => showScreen("chat"));
document.querySelector("#import-more-button").addEventListener("click", openDiscord);
document.querySelector("#chat-form").addEventListener("submit", submitQuestion);
document.querySelector("#refresh-overview-button").addEventListener("click", openDatabaseOverview);
document.querySelector("#load-more-chunks-button").addEventListener("click", () => {
  loadDatabaseOverview(true);
});
document.querySelector("#open-clear-database-button").addEventListener("click", openClearDatabaseDialog);
document.querySelector("#cancel-clear-button").addEventListener("click", closeClearDatabaseDialog);
document.querySelector("#clear-confirmation-input").addEventListener("input", updateClearConfirmation);
document.querySelector("#confirm-clear-button").addEventListener("click", clearDatabase);
document.querySelector("#home-button").addEventListener("click", async () => {
  await window.chatContext.hideDiscord();
  showScreen("home");
});

window.chatContext.onDiscordScanProgress(renderScanProgress);
