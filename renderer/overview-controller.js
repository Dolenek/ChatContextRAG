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
    const previousStatus = latestStatus;
    latestStatus = status;
    window.archiveStatus.render(status);
    window.indexingControls.render(
      status.indexing_jobs || [], status.pending_message_count || 0,
    );
    window.overviewMetricsView.render(status);
    renderSummaryState(status);
    updateChunkRange();
    scheduleStatusRefresh(status);
    if (projectionFinished(previousStatus, status)) {
      void refreshProjectionConsumers();
    }
  }

  function renderSummaryState(status) {
    const label = document.querySelector("#overview-summary-state");
    if (status.summary_ready === false) label.textContent = "Připravuji souhrn…";
    else if (status.summary_error) label.textContent = "Obnova souhrnu selhala";
    else if (status.summary_refreshing) label.textContent = "Aktualizuji souhrn…";
    else if (status.summary_is_stale) label.textContent = "Souhrn čeká na obnovení";
    else label.textContent = generatedSummaryLabel(status.summary_generated_at);
    const visiblyBusy = status.summary_ready === false || status.summary_refreshing;
    label.setAttribute("aria-busy", String(Boolean(visiblyBusy)));
  }

  function generatedSummaryLabel(generatedAt) {
    if (!generatedAt) return "";
    const generatedDate = new Date(generatedAt);
    if (Number.isNaN(generatedDate.getTime())) return "";
    return `Souhrn aktualizován ${generatedDate.toLocaleString("cs-CZ")}`;
  }

  function scheduleStatusRefresh(status) {
    clearStatusTimer();
    if (document.hidden) return;
    const hasActiveJobs = (status.indexing_jobs || []).some((job) =>
      ["queued", "running"].includes(job.status));
    const delay = summaryIsPending(status) ? summaryFollowUpMs
      : hasActiveJobs ? summaryRefreshIntervalMs : null;
    if (delay === null) return;
    statusTimer = window.setTimeout(() => {
      void refreshStatus({ forceClient: true });
    }, delay);
  }

  function summaryIsPending(status) {
    return status.summary_ready === false
      || Boolean(status.summary_refreshing || status.summary_is_stale);
  }

  function projectionFinished(previousStatus, currentStatus) {
    return Boolean(previousStatus && summaryIsPending(previousStatus)
      && currentStatus.summary_ready !== false
      && !summaryIsPending(currentStatus));
  }

  async function refreshProjectionConsumers() {
    window.workspaceCache.invalidate(
      "settings", "chat-scopes", "database-status",
      ...["channels", "authors", "embedding-models"].map(
        window.overviewBreakdownsView.pageCacheKey,
      ),
    );
    await Promise.allSettled([
      window.chatScopeSelector?.refresh(true),
      window.settingsUi?.refreshIndexState(),
      window.overviewBreakdownsView.loadInitial(true),
    ]);
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
    const rows = (page.chunks || []).map(createDatabaseChunkRow);
    if (!append && !rows.length) rows.push(createEmptyState(
      "Databáze zatím neobsahuje žádné chunky.",
    ));
    const chunkList = document.querySelector("#database-chunks");
    append ? chunkList.append(...rows) : chunkList.replaceChildren(...rows);
    displayedChunkCount = append
      ? displayedChunkCount + (page.chunks || []).length : (page.chunks || []).length;
    nextCursor = page.next_cursor || null;
    updateChunkButton(Boolean(page.has_more));
    updateChunkRange();
  }

  function createDatabaseChunkRow(chunk) {
    const chunkRow = document.createElement("div");
    const identifier = document.createElement("span");
    const content = document.createElement("span");
    const storedAt = document.createElement("span");
    chunkRow.className = "database-chunk-row";
    chunkRow.setAttribute("role", "row");
    identifier.className = "database-chunk-id";
    identifier.textContent = compactIdentifier(chunk.chunk_id);
    identifier.title = chunk.chunk_id;
    content.className = "database-chunk-content";
    content.textContent = chunk.content;
    storedAt.className = "database-chunk-stored-at";
    storedAt.textContent = window.overviewMetricsView.formatDate(chunk.updated_at);
    [identifier, content, storedAt].forEach((cell) => cell.setAttribute("role", "cell"));
    chunkRow.append(identifier, content, storedAt);
    return chunkRow;
  }

  function compactIdentifier(identifier) {
    const normalizedIdentifier = String(identifier || "");
    if (normalizedIdentifier.length <= 9) return normalizedIdentifier || "—";
    return `${normalizedIdentifier.slice(0, 4)}…${normalizedIdentifier.slice(-4)}`;
  }

  function updateChunkButton(hasMore) {
    const button = document.querySelector("#load-more-chunks-button");
    button.classList.toggle("hidden", !hasMore);
    button.textContent = "Zobrazit dalších 50 záznamů";
  }

  function updateChunkRange() {
    const total = latestStatus?.summary_ready === false
      ? "—" : window.overviewMetricsView.formatNumber(latestStatus?.total_chunks);
    document.querySelector("#chunk-range").textContent =
      `Zobrazeno ${window.overviewMetricsView.formatNumber(displayedChunkCount)} z ${total}`;
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
    label.setAttribute("role", "status");
    return label;
  }

  function setBusy(isBusy) {
    const refreshButton = document.querySelector("#refresh-overview-button");
    refreshButton.disabled = isBusy;
    refreshButton.setAttribute("aria-busy", String(isBusy));
    refreshButton.classList.toggle("loading", isBusy);
    document.querySelector("#refresh-overview-label").textContent =
      isBusy ? "Načítám…" : "Obnovit";
    const chunkButton = document.querySelector("#load-more-chunks-button");
    chunkButton.disabled = isBusy;
    if (isBusy && !chunkButton.classList.contains("hidden")) {
      chunkButton.textContent = "Načítám…";
    } else if (!isBusy) chunkButton.textContent = "Zobrazit dalších 50 záznamů";
  }

  function setStatusBusy(isBusy) {
    document.querySelector("#overview-summary").setAttribute("aria-busy", String(isBusy));
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
