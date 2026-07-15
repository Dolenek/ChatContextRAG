const toast = document.querySelector("#toast");
let channelScanRunning = false;
let scanStartedAt = null;
let scanTimerHandle = null;
let latestScanProgress = null;

async function openDiscord() {
  window.shellController.setDiscordActive(true);
  try {
    await window.chatContext.openDiscord();
  } catch (error) {
    window.shellController.setDiscordActive(false);
    showToast(error.message, true);
  }
}

async function closeDiscordView(showSources = true) {
  await window.chatContext.hideDiscord();
  window.shellController.setDiscordActive(false);
  if (showSources) window.shellController.openDrawerPanel("sources");
}

async function captureDiscordMessages() {
  setCaptureBusy(true);
  try {
    const result = await window.chatContext.captureDiscord();
    await closeDiscordView(false);
    showImportResult(
      `Zpracováno ${result.imported_count} zpráv a uloženo ${result.chunk_count} chunků.`,
      result.messages,
    );
    await refreshWorkspaceData();
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
  if (!channelScanRunning) {
    await runChannelScan(() => window.chatContext.resumeDiscordScan());
  }
}

async function runChannelScan(startOperation) {
  channelScanRunning = true;
  startScanTimer();
  updateScanButtons();
  try {
    const summary = await startOperation();
    latestScanProgress = summary;
    renderScanProgress(summary);
    await closeDiscordView(false);
    showImportResult(scanCompletionMessage(summary));
    await refreshWorkspaceData();
  } catch (error) {
    showToast(error.message, true);
  } finally {
    channelScanRunning = false;
    stopScanTimer();
    updateScanButtons();
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

function renderScanProgress(progress = {}) {
  latestScanProgress = progress;
  const waitingStates = ["waiting", "retrying", "recovering", "waiting-channel"];
  const waitingSuffix = waitingStates.includes(progress.state)
    ? ` · čekám a zkouším dál${progress.lastError ? `: ${progress.lastError}` : "…"}`
    : "";
  const stoppingSuffix = progress.state === "stopping" ? " · zastavuji…" : "";
  const pendingSuffix = progress.pendingMessages
    ? ` · čeká na raw uložení ${progress.pendingMessages}` : "";
  const elapsed = scanStartedAt ? ` · čas ${formatElapsed(Date.now() - scanStartedAt)}` : "";
  const status = document.querySelector("#scan-progress");
  status.textContent = `Nalezeno ${progress.discoveredMessages || 0} · raw uloženo ${progress.importedMessages || 0}${pendingSuffix}${elapsed}${waitingSuffix}${stoppingSuffix}`;
}

function renderIndexingProgress(job) {
  if (!job) return;
  window.indexingControls.applyProgress(job);
  const error = job.last_error ? ` · chyba: ${job.last_error}` : "";
  document.querySelector("#scan-progress").textContent =
    `RAG index: ${job.status} · zprávy ${job.processed_messages}/${job.total_messages} · chunky ${job.stored_chunks}${error}`;
  if (!["queued", "running"].includes(job.status)) {
    window.overviewController.refreshAfterTerminal();
    void window.settingsUi.refreshIndexState();
  }
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}

function updateScanButtons() {
  const scanButton = document.querySelector("#scan-channel-button");
  scanButton.textContent = channelScanRunning ? "Zastavit" : "Procházet do databáze";
  scanButton.classList.toggle("danger-button", channelScanRunning);
  document.querySelector("#capture-button").disabled = channelScanRunning;
  document.querySelector("#resume-scan-button").disabled = channelScanRunning;
}

function scanCompletionMessage(summary) {
  const prefix = summary.state === "completed"
    ? "Kanál byl projit až na začátek." : "Procházení bylo ukončeno.";
  return `${prefix} Nově uloženo ${summary.importedMessages || 0} zpráv v ${summary.storedChunks || 0} chunkech.`;
}

function setCaptureBusy(isBusy) {
  const button = document.querySelector("#capture-button");
  button.disabled = isBusy;
  button.textContent = isBusy ? "Načítám…" : "Načíst poslední 4";
}

function showImportResult(summary, messages = []) {
  document.querySelector("#import-summary").textContent = summary;
  document.querySelector("#message-list")
    .replaceChildren(...messages.slice(0, 20).map(createMessageCard));
  window.shellController.openDrawerPanel("importResult");
}

function createMessageCard(message) {
  const card = document.createElement("article");
  const metadata = document.createElement("div");
  const author = document.createElement("strong");
  const timestamp = document.createElement("span");
  const content = document.createElement("p");
  card.className = "message-card";
  metadata.className = "message-meta";
  author.textContent = message.author;
  timestamp.textContent = message.timestamp
    ? new Date(message.timestamp).toLocaleString("cs-CZ") : "Bez času";
  content.textContent = message.content;
  metadata.append(author, timestamp);
  card.append(metadata, content);
  return card;
}

async function refreshWorkspaceData() {
  window.workspaceCache.invalidate(
    "database-status", "database-breakdowns", "database-chunks:first", "chat-scopes",
  );
  await Promise.all([
    window.overviewController.refreshStatus(true),
    window.chatScopeSelector.refresh(true).catch((error) => showToast(error.message, true)),
  ]);
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
    await refreshWorkspaceData();
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

window.appUi = {
  clearDatabase, closeClearDatabaseDialog, closeDiscordView,
  openClearDatabaseDialog, openDiscord, refreshWorkspaceData,
  showImportResult, showToast, updateClearConfirmation,
};

window.chatContext.onDiscordScanProgress(renderScanProgress);
window.chatContext.onIndexingProgress(renderIndexingProgress);
