window.indexingControls = (() => {
  let refreshOverview;
  let showToast;
  let latestPendingCount = 0;
  let latestJobs = [];
  let pollHandle = null;
  let pollInFlight = false;
  const pollIntervalMs = 1500;

  function bind(options) {
    refreshOverview = options.refreshOverview;
    showToast = options.showToast;
    document.querySelector("#indexing-jobs").addEventListener("click", handleJobAction);
    document.querySelector("#index-pending-button").addEventListener(
      "click", queuePendingMessages,
    );
  }

  function render(jobs, pendingCount) {
    latestJobs = jobs;
    latestPendingCount = pendingCount;
    renderJobList();
    renderPendingButton();
    schedulePoll();
  }

  function renderJobList() {
    const rows = latestJobs.map(createJobRow);
    if (!rows.length) rows.push(createEmptyLabel());
    document.querySelector("#indexing-jobs").replaceChildren(...rows);
  }

  function createJobRow(job) {
    const row = document.createElement("div");
    const header = document.createElement("div");
    const summary = document.createElement("span");
    const chunks = document.createElement("strong");
    const button = document.createElement("button");
    const phase = document.createElement("small");
    const progress = document.createElement("div");
    const progressBar = document.createElement("span");
    const active = ["queued", "running"].includes(job.status);
    const percent = progressPercent(job);
    row.className = "indexing-job";
    header.className = "indexing-job-header";
    summary.textContent = jobStatusLabel(job, percent);
    chunks.textContent = `${formatNumber(job.stored_chunks)} chunků`;
    button.className = "job-action";
    button.dataset.jobId = job.job_id;
    button.dataset.action = active ? "cancel" : "retry";
    button.textContent = active ? "Zrušit" : "Opakovat";
    button.type = "button";
    phase.textContent = withSource(jobSourceLabel(job), jobPhaseLabel(job));
    progress.className = "indexing-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuenow", String(percent));
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progressBar.style.width = `${percent}%`;
    progress.append(progressBar);
    header.append(summary, chunks, button);
    row.append(header, phase, progress);
    return row;
  }

  function progressPercent(job) {
    if (job.status === "completed") return 100;
    if (!job.total_messages) return 0;
    return Math.min(100, Math.floor(job.processed_messages / job.total_messages * 100));
  }

  function jobStatusLabel(job, percent) {
    if (job.status === "queued") return "Čeká ve frontě";
    if (job.status === "running" && job.processed_messages === 0) return "Připravuji index";
    if (job.status === "running") return `Indexuji · ${percent} %`;
    if (job.status === "completed") return "Dokončeno · 100 %";
    if (job.status === "failed") return "Indexování selhalo";
    return "Indexování zrušeno";
  }

  function jobPhaseLabel(job) {
    if (job.status === "queued") return "Úloha čeká na volného indexovacího workera.";
    if (job.status === "running" && job.processed_messages === 0) {
      return `Připravuji ${formatNumber(job.total_messages)} zpráv a první embedding dávku…`;
    }
    if (job.status === "running" || job.status === "completed") {
      return `${formatNumber(job.processed_messages)} z ${formatNumber(job.total_messages)} zpráv`;
    }
    return job.last_error || "Úlohu lze spustit znovu.";
  }

  function jobSourceLabel(job) {
    if (job.source_type === "maintenance") return maintenanceSourceLabel(job);
    const values = [
      sourceTypeLabel(job.source_type), job.source_container_label,
      job.source_conversation_label,
    ];
    return values.filter(
      (value, index) => value && values.indexOf(value) === index,
    ).join(" · ");
  }

  function maintenanceSourceLabel(job) {
    const operation = {
      rebuild: "Rebuild indexu", sync: "Sync indexu",
    }[job.job_type] || "Doplnění indexu";
    return [operation, job.embedding_index_name].filter(Boolean).join(" · ");
  }

  function sourceTypeLabel(sourceType) {
    if (!sourceType) return "";
    return { discord: "Discord", whatsapp: "WhatsApp" }[sourceType]
      || sourceType.charAt(0).toUpperCase() + sourceType.slice(1);
  }

  function withSource(source, phase) {
    return source ? `${source} · ${phase}` : phase;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("cs-CZ");
  }

  function createEmptyLabel() {
    const label = document.createElement("span");
    label.className = "empty-label";
    label.textContent = "Žádné indexovací úlohy";
    return label;
  }

  function renderPendingButton() {
    const button = document.querySelector("#index-pending-button");
    const hasActiveJob = latestJobs.some((job) =>
      ["queued", "running"].includes(job.status));
    button.disabled = latestPendingCount === 0 || hasActiveJob;
    if (hasActiveJob) button.textContent = "Indexování běží…";
    else if (latestPendingCount === 0) button.textContent = "Vše zaindexováno";
    else button.textContent = `Zaindexovat čekající (${latestPendingCount})`;
  }

  function schedulePoll() {
    if (pollHandle) window.clearTimeout(pollHandle);
    pollHandle = null;
    if (!refreshOverview || !findActiveJob()) return;
    pollHandle = window.setTimeout(pollActiveJob, pollIntervalMs);
  }

  function findActiveJob() {
    return latestJobs.find((job) => ["queued", "running"].includes(job.status));
  }

  async function pollActiveJob() {
    pollHandle = null;
    const activeJob = findActiveJob();
    if (!activeJob || pollInFlight) return;
    pollInFlight = true;
    try {
      const currentJob = await window.chatContext.getIndexingJob(activeJob.job_id);
      latestJobs = latestJobs.map((job) =>
        job.job_id === currentJob.job_id ? currentJob : job);
      renderJobList();
      renderPendingButton();
      if (["queued", "running"].includes(currentJob.status)) schedulePoll();
      else await refreshOverview();
    } catch (_error) {
      schedulePoll();
    } finally {
      pollInFlight = false;
    }
  }

  async function queuePendingMessages() {
    const button = document.querySelector("#index-pending-button");
    button.disabled = true;
    button.textContent = "Zařazuji…";
    try {
      const job = await window.chatContext.indexPendingMessages();
      showToast(`Do indexování bylo zařazeno ${job.total_messages} zpráv.`);
      await refreshOverview();
    } catch (error) {
      showToast(error.message, true);
      renderPendingButton();
    }
  }

  async function handleJobAction(event) {
    const button = event.target.closest(".job-action");
    if (!button) return;
    button.disabled = true;
    try {
      if (button.dataset.action === "cancel") {
        await window.chatContext.cancelIndexingJob(button.dataset.jobId);
      } else {
        await window.chatContext.retryIndexingJob(button.dataset.jobId);
      }
      await refreshOverview();
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }

  return { bind, render, sourceLabel: jobSourceLabel };
})();
