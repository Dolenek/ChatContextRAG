window.overviewController = (() => {
  const pageSize = 50;
  const statusMaximumAgeMs = 5000;
  const detailMaximumAgeMs = 30000;
  const summaryRefreshIntervalMs = 60000;
  const summaryFollowUpMs = 8000;
  let latestStatus = null;
  let nextCursor = null;
  let displayedChunkCount = 0;
  let statusTimer = null;
  let terminalRefreshTimer = null;

  async function open() {
    renderCachedDatabase();
    setBusy(true);
    try {
      await Promise.all([
        refreshStatus(), window.overviewBreakdownsView.loadInitial(), loadFirstChunkPage(),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      await Promise.all([
        refreshStatus({ forceClient: true, fresh: true }),
        window.overviewBreakdownsView.loadInitial(true), loadFirstChunkPage(true),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus(options = {}) {
    const request = normalizeStatusOptions(options);
    const cached = window.workspaceCache.peek("database-status");
    if (cached) renderStatus(cached);
    setStatusBusy(true);
    try {
      const status = await window.workspaceCache.load(
        "database-status", () => window.chatContext.getDatabaseStatus({ fresh: request.fresh }),
        statusMaximumAgeMs, request.forceClient || request.fresh,
      );
      renderStatus(status);
      return status;
    } catch (error) {
      showLoadError(error);
      return cached || null;
    } finally {
      setStatusBusy(false);
    }
  }

  function normalizeStatusOptions(options) {
    if (options === true) return { forceClient: true, fresh: true };
    return { forceClient: false, fresh: false, ...options };
  }

  async function loadFirstChunkPage(force = false) {
    const cached = window.workspaceCache.peek("database-chunks:first");
    if (cached) renderChunkPage(cached, false);
    try {
      const page = await window.workspaceCache.load(
        "database-chunks:first", () => window.chatContext.getDatabaseChunkPage(pageSize),
        detailMaximumAgeMs, force,
      );
      renderChunkPage(page, false);
      return page;
    } catch (error) {
      showLoadError(error);
      if (!cached) renderChunkError();
      return cached || null;
    }
  }

  async function loadMore() {
    if (!nextCursor) return;
    setBusy(true);
    try {
      const page = await window.chatContext.getDatabaseChunkPage(pageSize, nextCursor);
      renderChunkPage(page, true);
    } catch (error) {
      showLoadError(error);
    } finally {
      setBusy(false);
    }
  }

  function renderCachedDatabase() {
    const status = window.workspaceCache.peek("database-status");
    const chunks = window.workspaceCache.peek("database-chunks:first");
    if (status) renderStatus(status);
    if (chunks) renderChunkPage(chunks, false);
    else renderChunkLoading();
  }

  function renderStatus(status) {
    latestStatus = status;
    window.archiveStatus.render(status);
    window.indexingControls.render(
      status.indexing_jobs || [], status.pending_message_count || 0,
    );
    window.overviewMetricsView.render(status);
    renderSummaryState(status);
    updateChunkRange();
    scheduleStatusRefresh(status);
  }

  function renderSummaryState(status) {
    const label = document.querySelector("#overview-summary-state");
    if (status.summary_refreshing) label.textContent = "Aktualizuji souhrn…";
    else if (status.summary_is_stale) label.textContent = "Souhrn čeká na obnovení";
    else label.textContent = "";
    label.setAttribute("aria-busy", String(Boolean(status.summary_refreshing)));
  }

  function scheduleStatusRefresh(status) {
    clearStatusTimer();
    if (document.hidden) return;
    const hasActiveJobs = (status.indexing_jobs || []).some((job) =>
      ["queued", "running"].includes(job.status));
    const delay = status.summary_refreshing ? summaryFollowUpMs
      : hasActiveJobs ? summaryRefreshIntervalMs : null;
    if (delay === null) return;
    statusTimer = window.setTimeout(() => {
      void refreshStatus({ forceClient: true });
    }, delay);
  }

  function clearStatusTimer() {
    if (statusTimer) window.clearTimeout(statusTimer);
    statusTimer = null;
  }

  function refreshAfterTerminal() {
    if (terminalRefreshTimer) window.clearTimeout(terminalRefreshTimer);
    terminalRefreshTimer = window.setTimeout(() => {
      terminalRefreshTimer = null;
      markDatabaseChanged();
      void refreshStatus({ forceClient: true, fresh: true });
    }, 2000);
  }

  function renderChunkPage(page, append) {
    const cards = (page.chunks || []).map(createDatabaseChunkCard);
    if (!append && !cards.length) cards.push(createEmptyState(
      "Databáze zatím neobsahuje žádné chunky.",
    ));
    const chunkList = document.querySelector("#database-chunks");
    append ? chunkList.append(...cards) : chunkList.replaceChildren(...cards);
    displayedChunkCount = append
      ? displayedChunkCount + (page.chunks || []).length : (page.chunks || []).length;
    nextCursor = page.next_cursor || null;
    document.querySelector("#load-more-chunks-button")
      .classList.toggle("hidden", !page.has_more);
    updateChunkRange();
  }

  function createDatabaseChunkCard(chunk) {
    const card = document.createElement("article");
    const header = document.createElement("div");
    const content = document.createElement("p");
    const footer = document.createElement("small");
    const authors = (chunk.authors || []).join(", ") || "Bez autora";
    const sourceCount = (chunk.source_message_ids || []).length;
    card.className = "database-chunk-card";
    header.className = "chunk-meta";
    header.textContent = `${chunk.channel || "Bez konverzace"} · ${authors} · ${window.overviewMetricsView.formatDate(chunk.started_at)}`;
    content.textContent = chunk.content;
    footer.textContent = `${chunk.embedding_model} · ${window.overviewMetricsView.formatNumber(sourceCount)} zdrojových zpráv · ID ${chunk.chunk_id.slice(0, 12)}`;
    card.append(header, content, footer);
    return card;
  }

  function updateChunkRange() {
    document.querySelector("#chunk-range").textContent =
      `Zobrazeno ${window.overviewMetricsView.formatNumber(displayedChunkCount)} z ${window.overviewMetricsView.formatNumber(latestStatus?.total_chunks)}`;
  }

  function renderChunkLoading() {
    document.querySelector("#database-chunks").replaceChildren(
      createEmptyState("Načítám chunky…"),
    );
  }

  function renderChunkError() {
    document.querySelector("#database-chunks").replaceChildren(
      createEmptyState("Chunky se nepodařilo načíst."),
    );
  }

  function createEmptyState(text) {
    const label = document.createElement("span");
    label.className = "overview-empty-state";
    label.textContent = text;
    return label;
  }

  function setBusy(isBusy) {
    const refreshButton = document.querySelector("#refresh-overview-button");
    refreshButton.disabled = isBusy;
    refreshButton.setAttribute("aria-busy", String(isBusy));
    refreshButton.classList.toggle("loading", isBusy);
    document.querySelector("#refresh-overview-label").textContent =
      isBusy ? "Načítám…" : "Obnovit";
    document.querySelector("#load-more-chunks-button").disabled = isBusy;
  }

  function setStatusBusy(isBusy) {
    document.querySelector("#overview-stats").setAttribute("aria-busy", String(isBusy));
    document.querySelector("#overview-status-stats")
      .setAttribute("aria-busy", String(isBusy));
  }

  function markDatabaseChanged() {
    window.workspaceCache.invalidate(
      "database-status", "database-chunks:first", "chat-scopes",
      ...["channels", "authors", "embedding-models"].map(
        window.overviewBreakdownsView.pageCacheKey,
      ),
    );
  }

  function showLoadError(error) {
    window.appUi?.showToast(error.message, true);
  }

  if (document.addEventListener) {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) clearStatusTimer();
      else if (latestStatus) void refreshStatus({ forceClient: true });
    });
  }

  return {
    getLatest: () => latestStatus, loadMore, markDatabaseChanged,
    open, refresh, refreshAfterTerminal, refreshStatus,
  };
})();
