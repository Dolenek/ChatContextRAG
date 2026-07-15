window.indexingControls = (() => {
  let refreshOverview;
  let refreshTerminal;
  let showToast;
  let latestPendingCount = 0;
  let latestJobs = [];
  let pollHandle = null;
  let pollInFlight = false;
  const jobRows = new Map();
  const lastPushAt = new Map();
  const pollIntervalMs = 10000;
  const pushFreshnessMs = 12000;

  function bind(options) {
    refreshOverview = options.refreshOverview;
    refreshTerminal = options.refreshTerminal || options.refreshOverview;
    showToast = options.showToast;
    document.querySelector("#indexing-jobs").addEventListener("click", handleJobAction);
    document.querySelector("#index-pending-button").addEventListener(
      "click", queuePendingMessages,
    );
    document.addEventListener?.("visibilitychange", handleVisibilityChange);
  }

  function render(jobs, pendingCount) {
    latestJobs = jobs;
    latestPendingCount = pendingCount;
    renderJobList();
    renderPendingButton();
    schedulePoll();
  }

  function renderJobList() {
    const visible = visibleJobs();
    const visibleIds = new Set(visible.map((job) => job.job_id));
    const rows = visible.map((job) => stableJobRow(job));
    [...jobRows.keys()].filter((jobId) => !visibleIds.has(jobId))
      .forEach((jobId) => jobRows.delete(jobId));
    if (!rows.length) rows.push(createEmptyLabel());
    const focusedJobId = document.activeElement?.dataset?.jobId;
    document.querySelector("#indexing-jobs").replaceChildren(...rows);
    jobRows.get(focusedJobId)?.jobParts.button.focus?.();
  }

  function stableJobRow(job) {
    const row = jobRows.get(job.job_id) || createJobRow(job.job_id);
    jobRows.set(job.job_id, row);
    updateJobRow(row, job);
    return row;
  }

  function visibleJobs() {
    return latestJobs
      .filter((job) => ["queued", "running"].includes(job.status))
      .sort((left, right) => activeJobPriority(left) - activeJobPriority(right));
  }

  function activeJobPriority(job) {
    return job.status === "running" ? 0 : 1;
  }

  function createJobRow(jobId) {
    const row = document.createElement("div");
    const header = document.createElement("div");
    const summary = document.createElement("span");
    const chunks = document.createElement("strong");
    const button = document.createElement("button");
    const phase = document.createElement("small");
    const progress = document.createElement("div");
    const progressBar = document.createElement("span");
    row.className = "indexing-job";
    header.className = "indexing-job-header";
    button.className = "job-action";
    button.dataset.jobId = jobId;
    button.type = "button";
    progress.className = "indexing-progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    progress.append(progressBar);
    header.append(summary, chunks, button);
    row.append(header, phase, progress);
    row.jobParts = { summary, chunks, button, phase, progress, progressBar };
    return row;
  }

  function updateJobRow(row, job) {
    const parts = row.jobParts;
    const active = ["queued", "running"].includes(job.status);
    const percent = progressPercent(job);
    parts.summary.textContent = jobStatusLabel(job, percent);
    parts.chunks.textContent = `${formatNumber(job.stored_chunks)} chunků`;
    parts.button.dataset.action = active ? "cancel" : "retry";
    parts.button.textContent = active ? "Zrušit" : "Opakovat";
    parts.phase.textContent = withSource(jobSourceLabel(job), jobPhaseLabel(job));
    parts.progress.setAttribute("aria-valuenow", String(percent));
    parts.progressBar.style.width = `${percent}%`;
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
    if (["running", "completed"].includes(job.status)) {
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
    return job.total_messages ? `${formatNumber(job.total_messages)} zpráv` : "Úloha";
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

  function schedulePoll(delay = pollIntervalMs) {
    if (pollHandle) window.clearTimeout(pollHandle);
    pollHandle = null;
    if (!refreshOverview || !findActiveJobs().length || document.hidden) return;
    pollHandle = window.setTimeout(pollActiveJobs, delay);
  }

  function findActiveJobs() {
    return latestJobs.filter((job) => ["queued", "running"].includes(job.status));
  }

  async function pollActiveJobs() {
    pollHandle = null;
    const previousJobs = findActiveJobs();
    if (!previousJobs.length || pollInFlight) return;
    if (!needsFallbackPoll(previousJobs)) return schedulePoll();
    pollInFlight = true;
    try {
      const currentJobs = await window.chatContext.getActiveIndexingJobs();
      const currentIds = new Set(currentJobs.map((job) => job.job_id));
      const reachedTerminal = previousJobs.some((job) => !currentIds.has(job.job_id));
      replaceActiveJobs(currentJobs);
      if (reachedTerminal && refreshTerminal) refreshTerminal();
    } catch {
      // Push remains primary; a later fallback attempt will reconcile the state.
    } finally {
      pollInFlight = false;
      schedulePoll();
    }
  }

  function needsFallbackPoll(activeJobs) {
    const now = Date.now();
    return activeJobs.some((job) =>
      now - (lastPushAt.get(job.job_id) || 0) >= pushFreshnessMs);
  }

  function applyProgress(job) {
    if (!job?.job_id) return;
    lastPushAt.set(job.job_id, Date.now());
    mergeJobUpdates([job]);
    if (["queued", "running"].includes(job.status)) schedulePoll();
    else if (refreshTerminal) refreshTerminal();
  }

  function replaceActiveJobs(activeJobs) {
    latestJobs = [
      ...activeJobs,
      ...latestJobs.filter((job) => !["queued", "running"].includes(job.status)),
    ];
    renderJobList();
    renderPendingButton();
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
      const operation = button.dataset.action === "cancel"
        ? window.chatContext.cancelIndexingJob : window.chatContext.retryIndexingJob;
      await operation(button.dataset.jobId);
      await refreshOverview();
    } catch (error) {
      showToast(error.message, true);
      button.disabled = false;
    }
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      if (pollHandle) window.clearTimeout(pollHandle);
      pollHandle = null;
    } else schedulePoll(0);
  }

  return { applyProgress, bind, render, sourceLabel: jobSourceLabel };
})();
