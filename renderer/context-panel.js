window.contextPanel = (() => {
  const contextList = document.querySelector("#context-list");
  const emptyState = document.querySelector("#context-empty");

  function showSources(sources = []) {
    const cards = sources.map(window.chatSources.createChatSourceCard);
    contextList.replaceChildren(...cards);
    emptyState.classList.toggle("hidden", cards.length > 0);
  }

  function clear() {
    showSources([]);
  }

  function renderOverview(overview) {
    const rawCount = Number(overview.raw_message_count || 0);
    const indexedCount = Number(overview.indexed_message_count || 0);
    const percent = rawCount ? Math.min(100, Math.floor(indexedCount / rawCount * 100)) : 0;
    document.querySelector("#index-percent").textContent = rawCount ? `${percent} %` : "—";
    document.querySelector("#index-raw-count").textContent = formatNumber(rawCount);
    document.querySelector("#indexed-count").textContent = formatNumber(indexedCount);
    document.querySelector("#index-chunk-count").textContent = formatNumber(overview.total_chunks);
    document.querySelector("#database-size").textContent = overview.database_size || "—";
    document.querySelector("#index-last-update").textContent = indexStatusLabel(overview);
    const progress = document.querySelector(".index-progress");
    progress.setAttribute("aria-valuenow", String(percent));
    document.querySelector("#index-progress-bar").style.width = `${percent}%`;
  }

  function indexStatusLabel(overview) {
    const jobs = overview.indexing_jobs || [];
    const hasRunningJob = jobs.some((job) => job.status === "running");
    const queuedCount = jobs.filter((job) => job.status === "queued").length;
    if (hasRunningJob && queuedCount) {
      return `Indexace právě probíhá · ve frontě: ${queuedCount}`;
    }
    if (hasRunningJob) return "Indexace právě probíhá";
    if (queuedCount) return `Indexace čeká ve frontě · ${queuedCount}`;
    if (overview.pending_message_count) {
      return `${formatNumber(overview.pending_message_count)} zpráv čeká`;
    }
    return overview.raw_message_count ? "Všechny zprávy jsou zpracované" : "Zatím bez dat";
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("cs-CZ");
  }

  return { clear, renderOverview, showSources };
})();
