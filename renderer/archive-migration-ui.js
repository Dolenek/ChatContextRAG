let archiveMigrationStatus = { available: false, phase: "unavailable" };
let archiveMigrationTarget = { mode: "web" };

function bindArchiveMigrationUi() {
  document.querySelector("#archive-migration-start").addEventListener("click", startMigration);
  document.querySelector("#archive-migration-pause").addEventListener("click", pauseMigration);
  document.querySelector("#archive-migration-resume").addEventListener("click", resumeMigration);
  document.querySelector("#archive-migration-index").addEventListener("click", indexMigration);
  document.querySelector("#archive-migration-switch").addEventListener("click", switchToServer);
  document.querySelector("#archive-migration-forget").addEventListener("click", forgetMigration);
  window.chatContext.onArchiveMigrationProgress(renderMigrationStatus);
}

async function refreshArchiveMigration(target) {
  archiveMigrationTarget = target;
  const panel = document.querySelector("#archive-migration-panel");
  panel.classList.toggle("hidden", target.mode !== "local");
  if (target.mode !== "local") return;
  try {
    renderMigrationStatus(await window.chatContext.getArchiveMigrationStatus());
  } catch (error) {
    showMigrationError(error);
  }
}

function connectionSelectionChanged() {
  renderMigrationStatus(archiveMigrationStatus);
}

function migrationConnectionInput() {
  return {
    mode: "remote",
    baseUrl: document.querySelector("#connection-url").value.trim(),
    token: document.querySelector("#connection-token").value.trim(),
    insecureHttpAcknowledged: document.querySelector(
      "#insecure-http-acknowledged",
    ).checked,
  };
}

async function startMigration() {
  try {
    const input = migrationConnectionInput();
    const inspection = await window.chatContext.inspectArchiveMigration(input);
    const message = `Přenést ${formatCount(inspection.sourceMessages)} lokálních zpráv na server, `
      + `který nyní obsahuje ${formatCount(inspection.destinationMessages)} zpráv?\n\n`
      + "Stejná ID se aktualizují lokální verzí; ostatní serverová data zůstanou zachována.";
    if (!window.confirm(message)) return;
    renderMigrationStatus({
      available: true, phase: "preparing", totalMessages: inspection.sourceMessages,
      transferredMessages: 0, baseUrl: inspection.baseUrl,
    });
    renderMigrationStatus(await window.chatContext.startArchiveMigration(input));
  } catch (error) {
    showMigrationError(error);
    await refreshCurrentStatus();
  }
}

async function pauseMigration() {
  try {
    renderMigrationStatus(await window.chatContext.pauseArchiveMigration());
  } catch (error) { showMigrationError(error); }
}

async function resumeMigration() {
  try {
    renderMigrationStatus({ ...archiveMigrationStatus, phase: "uploading", error: null });
    renderMigrationStatus(await window.chatContext.resumeArchiveMigration());
  } catch (error) {
    showMigrationError(error);
    await refreshCurrentStatus();
  }
}

async function indexMigration() {
  const warning = "Zaindexování může použít placené API podle konfigurace serveru. Pokračovat?";
  if (!window.confirm(warning)) return;
  try {
    const status = await window.chatContext.indexArchiveMigration();
    renderMigrationStatus(status);
    const count = status.indexingJobIds?.length || 0;
    showMigrationToast(count
      ? `Na serveru bylo zařazeno ${count} indexovacích jobů.`
      : "Server nemá žádný připravený auto-sync index.");
  } catch (error) { showMigrationError(error); }
}

async function switchToServer() {
  try {
    await window.chatContext.saveConnectionTarget({
      mode: "remote", baseUrl: archiveMigrationStatus.baseUrl, token: "",
    });
    showMigrationToast("Server byl uložen, aplikace se restartuje.");
  } catch (error) { showMigrationError(error); }
}

async function forgetMigration() {
  const incomplete = !["idle", "completed"].includes(archiveMigrationStatus.phase);
  if (incomplete && !window.confirm(
    "Zapomenout průběh? Již přenesené serverové zprávy se neodstraní.",
  )) return;
  try {
    renderMigrationStatus(await window.chatContext.forgetArchiveMigration());
  } catch (error) { showMigrationError(error); }
}

async function refreshCurrentStatus() {
  try {
    renderMigrationStatus(await window.chatContext.getArchiveMigrationStatus());
  } catch { /* The original operation error is already visible. */ }
}

function renderMigrationStatus(status) {
  archiveMigrationStatus = status;
  const phase = status.phase || "idle";
  document.querySelector("#archive-migration-status").textContent = migrationStatusText(status);
  renderMigrationProgress(status);
  renderMigrationDetails(status);
  toggleMigrationButton("#archive-migration-start", phase === "idle");
  toggleMigrationButton("#archive-migration-pause", phase === "uploading");
  toggleMigrationButton(
    "#archive-migration-resume", ["paused", "failed", "interrupted"].includes(phase),
  );
  toggleMigrationButton("#archive-migration-index", phase === "completed"
    && !status.indexingQueuedAt);
  toggleMigrationButton("#archive-migration-switch", phase === "completed");
  toggleMigrationButton(
    "#archive-migration-forget", ["paused", "failed", "interrupted", "completed"].includes(phase),
  );
  const remoteSelected = document.querySelector("#connection-mode").value === "remote";
  const targetUrl = document.querySelector("#connection-url").value.trim();
  const missingHttpAcknowledgement = window.connectionSecurity
    .requiresInsecureHttpAcknowledgement(targetUrl)
    && !document.querySelector("#insecure-http-acknowledged").checked;
  document.querySelector("#archive-migration-start").disabled = !remoteSelected
    || !targetUrl || missingHttpAcknowledgement;
}

function renderMigrationProgress(status) {
  const progress = document.querySelector("#archive-migration-progress");
  const total = status.totalMessages || 0;
  const transferred = status.transferredMessages || 0;
  const percent = total ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
  const visible = !["idle", "unavailable"].includes(status.phase);
  progress.classList.toggle("hidden", !visible);
  progress.setAttribute("aria-valuenow", String(percent));
  progress.querySelector("span").style.width = `${percent}%`;
}

function renderMigrationDetails(status) {
  const checkpoint = status.lastCheckpoint || (status.cursor ? {
    cursor: status.cursor, transferredMessages: status.transferredMessages,
  } : null);
  setDetail("#archive-migration-checkpoint", checkpoint
    ? `Poslední checkpoint: ${formatCount(checkpoint.transferredMessages)} zpráv · cursor ${checkpoint.cursor}`
    : "");
  setDetail("#archive-migration-last-batch", status.lastBatchAt
    ? `Poslední potvrzená dávka: ${formatDate(status.lastBatchAt)}` : "");
  setDetail("#archive-migration-diagnostic", migrationDiagnosticText(status));
}

function migrationDiagnosticText(status) {
  const attempt = status.retryAttempt
    ? ` · pokus ${status.retryAttempt}/${status.maxAttempts || 3}` : "";
  if (status.phase === "recovering_backend") return `Obnovuji lokální backend${attempt}`;
  if (status.phase === "retrying") return `Opakuji nedokončený požadavek${attempt}`;
  if (!status.lastTimeoutEndpoint) return "";
  const health = status.lastHealth?.healthy ? "health odpověděl" : "health neodpověděl";
  return `Poslední timeout: ${status.lastTimeoutEndpoint} · ${health}`;
}

function migrationStatusText(status) {
  const count = `${formatCount(status.transferredMessages || 0)} / ${formatCount(status.totalMessages || 0)}`;
  const labels = {
    idle: "Přeneste raw zprávy a Discord synchronizační stav na vybraný server.",
    preparing: "Vytvářím stabilní snapshot lokálního archivu…",
    uploading: `Přenáším zprávy: ${count}`,
    pausing: `Dokončuji aktuální dávku: ${count}`,
    paused: `Přenos je pozastaven: ${count}`,
    interrupted: `Přenos byl přerušen a lze bezpečně pokračovat: ${count}`,
    retrying: `Opakuji požadavek: ${count}`,
    recovering_backend: `Obnovuji lokální backend: ${count}`,
    syncing: `Slučuji Discord stav a ověřuji server: ${count}`,
    verifying: `Porovnávám přesný počet zpráv na obou stranách: ${count}`,
    cleaning_snapshot: `Počty souhlasí, odstraňuji lokální snapshot: ${count}`,
    completed: `Přenos dokončen a ověřen: ${count}`,
    failed: `Přenos selhal u ${count}: ${status.error || "neznámá chyba"}`,
    unavailable: "Přenos je dostupný pouze v Local režimu.",
  };
  if (status.indexingQueuedAt) return `${labels.completed} Indexování bylo zařazeno.`;
  return labels[status.phase] || labels.idle;
}

function setDetail(selector, text) {
  const element = document.querySelector(selector);
  element.textContent = text;
  element.classList.toggle("hidden", !text);
}

function toggleMigrationButton(selector, visible) {
  document.querySelector(selector).classList.toggle("hidden", !visible);
}

function formatCount(value) {
  return Number(value || 0).toLocaleString("cs-CZ");
}

function formatDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("cs-CZ");
}

function showMigrationError(error) {
  showMigrationToast(error.message, true);
}

function showMigrationToast(message, isError = false) {
  window.appUi?.showToast(message, isError);
}

bindArchiveMigrationUi();
window.archiveMigrationUi = {
  connectionSelectionChanged,
  refresh: refreshArchiveMigration,
};
