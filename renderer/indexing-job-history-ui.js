window.indexingJobHistoryUi = (() => {
  let refreshSettings = async () => {};
  let showToast = () => {};

  function bind(options) {
    refreshSettings = options.refreshSettings;
    showToast = options.showToast;
  }

  function render(jobs = []) {
    const terminalJobs = jobs.filter((job) =>
      ["completed", "failed", "cancelled"].includes(job.status));
    const rows = terminalJobs.map(createHistoryRow);
    if (!rows.length) rows.push(createEmptyHistory());
    document.querySelector("#indexing-job-history").replaceChildren(...rows);
  }

  function createHistoryRow(job) {
    const row = document.createElement("article");
    const heading = document.createElement("strong");
    const detail = document.createElement("small");
    row.className = "settings-row";
    heading.textContent = `${job.embedding_index_name || "Embedding index"} · ${statusLabel(job)}`;
    detail.textContent = historyDetail(job);
    if (job.status === "failed") detail.className = "error-detail";
    row.append(heading, detail);
    if (["failed", "cancelled"].includes(job.status)) {
      row.append(actionButton(job.job_id));
    }
    return row;
  }

  function historyDetail(job) {
    const progress = `${formatNumber(job.processed_messages)} z ${formatNumber(job.total_messages)} zpráv`;
    const chunks = `${formatNumber(job.stored_chunks)} chunků`;
    return [progress, chunks, job.last_error].filter(Boolean).join(" · ");
  }

  function statusLabel(job) {
    return {
      completed: "Dokončeno", failed: "Selhalo", cancelled: "Zrušeno",
    }[job.status] || job.status;
  }

  function actionButton(jobId) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "settings-action";
    button.textContent = "Spustit znovu";
    button.addEventListener("click", () => retryJob(jobId, button));
    return button;
  }

  async function retryJob(jobId, button) {
    try {
      await window.interactionCoordinator.runMutation({
        key: `retry-indexing-job:${jobId}`,
        controls: [{ element: button, pendingText: "Zařazuji…" }],
        execute: () => window.chatContext.retryIndexingJob(jobId),
        commit: (job) => {
          window.indexingControls.applyProgress(job);
          showToast("Indexovací úloha byla znovu zařazena.");
        },
        reconcile: refreshSettings,
        reconcileFailed: (error) => showToast(
          `Úloha je zařazená, obnovení selhalo: ${error.message}`, true,
        ),
      });
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function createEmptyHistory() {
    const label = document.createElement("span");
    label.className = "empty-label";
    label.textContent = "Historie je prázdná.";
    return label;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("cs-CZ");
  }

  return { bind, render };
})();
