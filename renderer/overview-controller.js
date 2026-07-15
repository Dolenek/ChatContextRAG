window.overviewController = (() => {
  const pageSize = 50;
  const statusMaximumAgeMs = 5000;
  const detailMaximumAgeMs = 30000;
  const numberFormatter = new Intl.NumberFormat("cs-CZ");
  const primaryMetrics = [
    metric("Chunky", "total_chunks", "icon-layers", "blue"),
    metric("Zdrojové zprávy", "total_source_messages", "icon-documents", "violet"),
    metric("Raw zprávy", "raw_message_count", "icon-file-text", "sky"),
    metric("Unikátní texty", "unique_content_count", "icon-fingerprint", "green"),
    metric("Přesné duplicity", "duplicate_message_count", "icon-copy", "amber"),
    metric("Zaindexované zprávy", "indexed_message_count", "icon-search-index", "teal"),
  ];
  const statusMetrics = [
    metric("Čeká na index", "pending_message_count", "icon-clock", "rose"),
    metric("Velikost databáze", "database_size", "icon-database", "blue", "text"),
    metric("Konverzace", "total_channels", "icon-chat", "violet"),
    metric("Nejstarší zpráva", "oldest_message_at", "icon-calendar", "green", "date"),
    metric("Nejnovější zpráva", "newest_message_at", "icon-calendar", "teal", "date"),
  ];
  let latestStatus = null;
  let latestBreakdowns = null;
  let nextCursor = null;
  let displayedChunkCount = 0;

  function metric(label, key, icon, tone, format = "number") {
    return { label, key, icon, tone, format };
  }

  async function open() {
    renderCachedDatabase();
    setBusy(true);
    try {
      await Promise.all([refreshStatus(), loadBreakdowns(), loadFirstChunkPage()]);
    } finally {
      setBusy(false);
    }
  }

  async function refresh() {
    setBusy(true);
    try {
      await Promise.all([
        refreshStatus(true), loadBreakdowns(true), loadFirstChunkPage(true),
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function refreshStatus(force = false) {
    const cached = window.workspaceCache.peek("database-status");
    if (cached) renderStatus(cached);
    try {
      const status = await window.workspaceCache.load(
        "database-status", window.chatContext.getDatabaseStatus,
        statusMaximumAgeMs, force,
      );
      renderStatus(status);
      return status;
    } catch (error) {
      showLoadError(error);
      return cached || null;
    }
  }

  async function loadBreakdowns(force = false) {
    const cached = window.workspaceCache.peek("database-breakdowns");
    if (cached) renderBreakdowns(cached);
    try {
      const breakdowns = await window.workspaceCache.load(
        "database-breakdowns", window.chatContext.getDatabaseBreakdowns,
        detailMaximumAgeMs, force,
      );
      renderBreakdowns(breakdowns);
      return breakdowns;
    } catch (error) {
      showLoadError(error);
      if (!cached) renderBreakdownError();
      return cached || null;
    }
  }

  async function loadFirstChunkPage(force = false) {
    const cached = window.workspaceCache.peek("database-chunks:first");
    if (cached) renderChunkPage(cached, false);
    try {
      const page = await window.workspaceCache.load(
        "database-chunks:first",
        () => window.chatContext.getDatabaseChunkPage(pageSize),
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
    const breakdowns = window.workspaceCache.peek("database-breakdowns");
    const chunks = window.workspaceCache.peek("database-chunks:first");
    if (status) renderStatus(status);
    if (breakdowns) renderBreakdowns(breakdowns);
    else renderBreakdownLoading();
    if (chunks) renderChunkPage(chunks, false);
    else renderChunkLoading();
  }

  function renderStatus(status) {
    latestStatus = status;
    window.archiveStatus.render(status);
    window.indexingControls.render(
      status.indexing_jobs || [], status.pending_message_count || 0,
    );
    renderMetricGroup("#overview-stats", primaryMetrics, status, "primary");
    renderMetricGroup("#overview-status-stats", statusMetrics, status, "status");
    renderTotal("#channel-total", status.total_channels);
    renderTotal("#author-total", status.total_authors);
    updateChunkRange();
  }

  function renderBreakdowns(breakdowns) {
    latestBreakdowns = breakdowns;
    renderCountList("#channel-counts", breakdowns.channels);
    renderCountList("#author-counts", breakdowns.authors);
    renderCountList("#model-counts", breakdowns.embedding_models);
    renderTotal("#model-total", (breakdowns.embedding_models || []).length);
  }

  function renderMetricGroup(selector, definitions, status, variant) {
    const cards = definitions.map((definition) => createMetricCard(
      definition, formatMetricValue(definition, status[definition.key]), variant,
    ));
    document.querySelector(selector).replaceChildren(...cards);
  }

  function createMetricCard(definition, value, variant) {
    const card = document.createElement("article");
    const copy = document.createElement("div");
    const valueElement = document.createElement("strong");
    const labelElement = document.createElement("span");
    card.className = `overview-metric-card overview-${variant}-card tone-${definition.tone}`;
    card.setAttribute("aria-label", `${definition.label}: ${value}`);
    valueElement.textContent = value;
    labelElement.textContent = definition.label;
    copy.className = "overview-metric-copy";
    copy.append(valueElement, labelElement);
    card.append(createMetricIcon(definition.icon), copy);
    return card;
  }

  function createMetricIcon(iconId) {
    const wrapper = document.createElement("span");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    wrapper.className = "overview-metric-icon";
    wrapper.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `assets/icon-sprite.svg#${iconId}`);
    svg.append(use);
    wrapper.append(svg);
    return wrapper;
  }

  function renderTotal(selector, value) {
    document.querySelector(selector).textContent = `${formatNumber(value)} celkem`;
  }

  function renderCountList(selector, counts = []) {
    const entries = counts.map((item, index) => createCountRow(item, index));
    if (!entries.length) entries.push(createEmptyState("Zatím bez dat", "empty-label"));
    document.querySelector(selector).replaceChildren(...entries);
  }

  function createCountRow(item, index) {
    const row = document.createElement("div");
    const rank = document.createElement("span");
    const label = document.createElement("span");
    const count = document.createElement("strong");
    row.className = "overview-count-row";
    rank.className = "overview-count-rank";
    rank.textContent = index + 1;
    label.className = "overview-count-label";
    label.textContent = item.label;
    label.title = item.label;
    count.textContent = formatNumber(item.count);
    row.append(rank, label, count);
    return row;
  }

  function renderChunkPage(page, append) {
    const cards = (page.chunks || []).map(createDatabaseChunkCard);
    if (!append && !cards.length) {
      cards.push(createEmptyState("Databáze zatím neobsahuje žádné chunky."));
    }
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
    header.textContent = `${chunk.channel || "Bez konverzace"} · ${authors} · ${formatDate(chunk.started_at)}`;
    content.textContent = chunk.content;
    footer.textContent = `${chunk.embedding_model} · ${formatNumber(sourceCount)} zdrojových zpráv · ID ${chunk.chunk_id.slice(0, 12)}`;
    card.append(header, content, footer);
    return card;
  }

  function updateChunkRange() {
    document.querySelector("#chunk-range").textContent =
      `Zobrazeno ${formatNumber(displayedChunkCount)} z ${formatNumber(latestStatus?.total_chunks)}`;
  }

  function renderBreakdownLoading() {
    ["#channel-counts", "#author-counts", "#model-counts"].forEach((selector) => {
      document.querySelector(selector).replaceChildren(createEmptyState("Načítám…", "empty-label"));
    });
  }

  function renderBreakdownError() {
    ["#channel-counts", "#author-counts", "#model-counts"].forEach((selector) => {
      document.querySelector(selector).replaceChildren(
        createEmptyState("Data se nepodařilo načíst", "empty-label"),
      );
    });
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

  function createEmptyState(text, className = "overview-empty-state") {
    const label = document.createElement("span");
    label.className = className;
    label.textContent = text;
    return label;
  }

  function formatMetricValue(definition, value) {
    if (definition.format === "date") return formatDate(value);
    if (definition.format === "text") return value || "—";
    return formatNumber(value);
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    const number = Number(value);
    return Number.isFinite(number) ? numberFormatter.format(number) : String(value);
  }

  function formatDate(value) {
    if (!value) return "Bez času";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Bez času" : date.toLocaleString("cs-CZ");
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

  function markDatabaseChanged() {
    window.workspaceCache.invalidate(
      "database-status", "database-breakdowns", "database-chunks:first", "chat-scopes",
    );
  }

  function showLoadError(error) {
    window.appUi?.showToast(error.message, true);
  }

  return {
    getLatest: () => latestStatus, loadMore, markDatabaseChanged,
    open, refresh, refreshStatus,
  };
})();
