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
    const rows = visibleJobs().map(createJobRow);
    if (!rows.length) rows.push(createEmptyLabel());
    document.querySelector("#indexing-jobs").replaceChildren(...rows);
  }

  function visibleJobs() {
    return latestJobs
      .filter((job) => ["queued", "running"].includes(job.status))
      .sort((left, right) => activeJobPriority(left) - activeJobPriority(right));
  }

  function activeJobPriority(job) {
    return job.status === "running" ? 0 : 1;
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
    return Math.min(100, Math.floor(job.processed_messages * 100 / job.total_messages));
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
    if (job.status === "queued" && hasRunningJobForIndex(job)) {
      return `${queuedMessageCount(job)} čeká na dokončení právě běžící úlohy; potom se spustí automaticky.`;
    }
    if (job.status === "queued") {
      return `${queuedMessageCount(job)} čeká na volného indexovacího workera.`;
    }
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
    const incrementalLabel = hasRunningJobForIndex(job)
      ? "Navazující indexace" : "Indexace čekajících zpráv";
    const operation = {
      rebuild: "Rebuild indexu", sync: "Sync indexu",
    }[job.job_type] || incrementalLabel;
    return [operation, job.embedding_index_name].filter(Boolean).join(" · ");
  }

  function hasRunningJobForIndex(queuedJob) {
    return latestJobs.some((job) => job.job_id !== queuedJob.job_id
      && job.embedding_index_id === queuedJob.embedding_index_id
      && job.status === "running");
  }

  function queuedMessageCount(job) {
    return job.total_messages
      ? `${formatNumber(job.total_messages)} zpráv` : "Úloha";
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
    label.textContent = "Žádné aktivní indexovací úlohy";
    return label;
  }

  function renderPendingButton() {
    const button = document.querySelector("#index-pending-button");
    const hasRunningJob = latestJobs.some((job) => job.status === "running");
    const queuedCount = latestJobs.filter((job) => job.status === "queued").length;
    button.disabled = latestPendingCount === 0 || hasRunningJob || queuedCount > 0;
    if (hasRunningJob && queuedCount) {
      button.textContent = `Indexování běží · ve frontě: ${queuedCount}`;
    } else if (hasRunningJob) button.textContent = "Indexování běží…";
    else if (queuedCount) button.textContent = `Indexování čeká ve frontě · ${queuedCount}`;
    else if (latestPendingCount === 0) button.textContent = "Vše zaindexováno";
    else button.textContent = `Zaindexovat čekající (${latestPendingCount})`;
  }

  function schedulePoll() {
    if (pollHandle) window.clearTimeout(pollHandle);
    pollHandle = null;
    if (!refreshOverview || !findActiveJobs().length) return;
    pollHandle = window.setTimeout(pollActiveJobs, pollIntervalMs);
  }

  function findActiveJobs() {
    return latestJobs.filter((job) => ["queued", "running"].includes(job.status));
  }

  async function pollActiveJobs() {
    pollHandle = null;
    const activeJobs = findActiveJobs();
    if (!activeJobs.length || pollInFlight) return;
    pollInFlight = true;
    let reachedTerminalState = false;
    try {
      const results = await Promise.allSettled(activeJobs.map((job) =>
        window.chatContext.getIndexingJob(job.job_id)));
      const currentJobs = results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value);
      reachedTerminalState = currentJobs.some((job) =>
        !["queued", "running"].includes(job.status));
      mergeJobUpdates(currentJobs);
    } finally {
      pollInFlight = false;
    }
    if (reachedTerminalState) await refreshOverview();
    else schedulePoll();
  }

  function applyProgress(job) {
    if (!job?.job_id) return;
    mergeJobUpdates([job]);
    if (["queued", "running"].includes(job.status)) schedulePoll();
    else if (refreshOverview) void refreshOverview();
  }

  function mergeJobUpdates(updates) {
    const updatesById = new Map(updates.map((job) => [job.job_id, job]));
    latestJobs = latestJobs.map((job) => updatesById.get(job.job_id) || job);
    updates.forEach((job) => {
      if (!latestJobs.some((current) => current.job_id === job.job_id)) {
        latestJobs.unshift(job);
      }
    });
    renderJobList();
    renderPendingButton();
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

  return { applyProgress, bind, render, sourceLabel: jobSourceLabel };
})();
