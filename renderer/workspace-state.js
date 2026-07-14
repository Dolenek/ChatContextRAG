window.workspaceCache = (() => {
  const entries = new Map();

  function peek(key) {
    const entry = entries.get(key);
    return entry?.hasValue ? entry.value : undefined;
  }

  function load(key, loader, maximumAgeMs, force = false) {
    const entry = entries.get(key) || {
      hasValue: false, loadedAt: 0, inFlight: null, revision: 0,
    };
    entries.set(key, entry);
    const isFresh = entry.hasValue && Date.now() - entry.loadedAt < maximumAgeMs;
    if (!force && isFresh) return Promise.resolve(entry.value);
    if (entry.inFlight && entry.inFlightRevision === entry.revision) {
      return entry.inFlight;
    }
    const requestRevision = entry.revision;
    const request = Promise.resolve().then(loader).then((value) => {
      if (entry.revision !== requestRevision) return value;
      Object.assign(entry, { value, hasValue: true, loadedAt: Date.now() });
      return value;
    }).finally(() => {
      if (entry.inFlight === request) entry.inFlight = null;
    });
    entry.inFlight = request;
    entry.inFlightRevision = requestRevision;
    return request;
  }

  function invalidate(...keys) {
    keys.forEach((key) => {
      const entry = entries.get(key);
      if (entry) {
        entry.loadedAt = 0;
        entry.revision += 1;
      }
    });
  }

  function store(key, value) {
    const entry = entries.get(key) || {};
    const revision = (entry.revision || 0) + 1;
    Object.assign(entry, {
      value, hasValue: true, loadedAt: Date.now(),
      inFlight: entry.inFlight || null, revision,
    });
    entries.set(key, entry);
    return value;
  }

  return { invalidate, load, peek, store };
})();

window.archiveStatus = (() => {
  function render(status) {
    const rawCount = Number(status.raw_message_count || 0);
    const indexedCount = Number(status.indexed_message_count || 0);
    const percent = rawCount ? Math.min(100, Math.floor(indexedCount / rawCount * 100)) : 0;
    document.querySelector("#index-percent").textContent = rawCount ? `${percent} %` : "—";
    document.querySelector("#index-raw-count").textContent = formatNumber(rawCount);
    document.querySelector("#indexed-count").textContent = formatNumber(indexedCount);
    document.querySelector("#index-chunk-count").textContent = formatNumber(status.total_chunks);
    document.querySelector("#database-size").textContent = status.database_size || "—";
    document.querySelector("#index-last-update").textContent = indexStatusLabel(status);
    document.querySelector("#archive-status-label").textContent = archiveLabel(rawCount, percent);
    updateProgress(percent);
  }

  function updateProgress(percent) {
    const progress = document.querySelector(".index-progress");
    progress.setAttribute("aria-valuenow", String(percent));
    document.querySelector("#index-progress-bar").style.width = `${percent}%`;
    document.querySelector("#archive-header-progress-bar").style.width = `${percent}%`;
  }

  function archiveLabel(rawCount, percent) {
    return rawCount ? `Archiv připraven z ${percent} %` : "Archiv je prázdný";
  }

  function indexStatusLabel(status) {
    const jobs = status.indexing_jobs || [];
    const hasRunningJob = jobs.some((job) => job.status === "running");
    const queuedCount = jobs.filter((job) => job.status === "queued").length;
    if (hasRunningJob && queuedCount) return `Indexace probíhá · ve frontě: ${queuedCount}`;
    if (hasRunningJob) return "Indexace právě probíhá";
    if (queuedCount) return `Indexace čeká ve frontě · ${queuedCount}`;
    if (status.pending_message_count) {
      return `${formatNumber(status.pending_message_count)} zpráv čeká`;
    }
    return status.raw_message_count ? "Všechny zprávy jsou zpracované" : "Zatím bez dat";
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("cs-CZ");
  }

  return { render };
})();
