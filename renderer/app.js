const screens = {
  home: document.querySelector("#home-screen"),
  result: document.querySelector("#result-screen"),
  chat: document.querySelector("#chat-screen"),
  overview: document.querySelector("#overview-screen"),
  discordBot: document.querySelector("#discord-bot-screen"),
  whatsapp: document.querySelector("#whatsapp-screen"),
  settings: document.querySelector("#settings-screen"),
};
const discordActions = document.querySelector("#discord-actions");
const toast = document.querySelector("#toast");
const overviewPageSize = 50;
let overviewOffset = 0;
let channelScanRunning = false;
let scanStartedAt = null;
let scanTimerHandle = null;
let latestScanProgress = null;

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
    latestScanProgress = { ...latestScanProgress, state: "stopping" };
    renderScanProgress(latestScanProgress);
    await window.chatContext.stopDiscordScan();
    return;
  }
  await runChannelScan(() => window.chatContext.startDiscordScan());
}

async function resumeChannelScan() {
  if (channelScanRunning) return;
  await runChannelScan(() => window.chatContext.resumeDiscordScan());
}

async function runChannelScan(startOperation) {
  channelScanRunning = true;
  startScanTimer();
  updateScanButton();
  try {
    const summary = await startOperation();
    latestScanProgress = summary;
    renderScanProgress(summary);
    showToast(scanCompletionMessage(summary));
  } catch (error) {
    showToast(error.message, true);
  } finally {
    channelScanRunning = false;
    stopScanTimer();
    updateScanButton();
  }
}

function startScanTimer() {
  scanStartedAt = Date.now();
  latestScanProgress = {
    discoveredMessages: 0, importedMessages: 0, storedChunks: 0, state: "preparing",
  };
  renderScanProgress(latestScanProgress);
  scanTimerHandle = window.setInterval(() => renderScanProgress(latestScanProgress), 1000);
}

function stopScanTimer() {
  if (scanTimerHandle) window.clearInterval(scanTimerHandle);
  scanTimerHandle = null;
}

function renderScanProgress(progress) {
  latestScanProgress = progress;
  const status = document.querySelector("#scan-progress");
  const waitingStates = ["waiting", "retrying", "recovering", "waiting-channel"];
  const waitingSuffix = waitingStates.includes(progress.state)
    ? ` · čekám a zkouším dál${progress.lastError ? `: ${progress.lastError}` : "…"}`
    : "";
  const stoppingSuffix = progress.state === "stopping" ? " · zastavuji…" : "";
  const pendingSuffix = progress.pendingMessages ? ` · čeká na raw uložení ${progress.pendingMessages}` : "";
  const elapsed = scanStartedAt ? ` · čas ${formatElapsed(Date.now() - scanStartedAt)}` : "";
  status.textContent = `Discord: nalezeno ${progress.discoveredMessages || 0} · raw uloženo ${progress.importedMessages || 0}${pendingSuffix}${elapsed}${waitingSuffix}${stoppingSuffix}`;
  status.title = status.textContent;
}

function renderIndexingProgress(job) {
  const status = document.querySelector("#scan-progress");
  const error = job.last_error ? ` · chyba: ${job.last_error}` : "";
  status.textContent = `RAG index: ${job.status} · zprávy ${job.processed_messages}/${job.total_messages} · chunky ${job.stored_chunks}${error}`;
  status.title = status.textContent;
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}

function updateScanButton() {
  const button = document.querySelector("#scan-channel-button");
  button.textContent = channelScanRunning ? "Zastavit" : "Procházet do databáze";
  button.classList.toggle("scanning", channelScanRunning);
  document.querySelector("#capture-button").disabled = channelScanRunning;
  document.querySelector("#resume-scan-button").disabled = channelScanRunning;
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
  window.indexingControls.render(
    overview.indexing_jobs || [], overview.pending_message_count || 0,
  );
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
    ["Raw zprávy", overview.raw_message_count],
    ["Unikátní texty", overview.unique_content_count],
    ["Přesné duplicity", overview.duplicate_message_count],
    ["Zaindexované zprávy", overview.indexed_message_count],
    ["Čeká na index", overview.pending_message_count],
    ["Velikost databáze", overview.database_size],
    ["Konverzace", overview.total_channels], ["Autoři", overview.total_authors],
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
  header.textContent = `${chunk.channel || "Bez konverzace"} · ${chunk.authors.join(", ")} · ${formatDate(chunk.started_at)}`;
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
    showToast(`Databáze byla vymazána. Chunky: ${result.deleted_chunks} · raw zprávy: ${result.deleted_messages || 0}`);
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
