window.overviewController = (() => {
  const pageSize = 50;
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
  let offset = 0;
  let latestOverview = null;

  function metric(label, key, icon, tone, format = "number") {
    return { label, key, icon, tone, format };
  }

  function refresh() {
    return load(false, 0);
  }

  function loadMore() {
    return load(true, offset);
  }

  async function load(append, requestOffset) {
    setBusy(true);
    try {
      const overview = await window.chatContext.getDatabaseOverview(pageSize, requestOffset);
      latestOverview = overview;
      renderOverview(overview, append);
      offset = requestOffset + overview.chunks.length;
      return overview;
    } catch (error) {
      window.appUi?.showToast(error.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function renderOverview(overview, append) {
    window.contextPanel.renderOverview(overview);
    window.indexingControls.render(
      overview.indexing_jobs || [], overview.pending_message_count || 0,
    );
    renderMetricGroup("#overview-stats", primaryMetrics, overview, "primary");
    renderMetricGroup("#overview-status-stats", statusMetrics, overview, "status");
    renderSummaryPanels(overview);
    renderChunks(overview, append);
  }

  function renderMetricGroup(selector, definitions, overview, variant) {
    const cards = definitions.map((definition) => {
      const value = formatMetricValue(definition, overview[definition.key]);
      return createMetricCard(definition, value, variant);
    });
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
    use.setAttribute("href", `#${iconId}`);
    svg.append(use);
    wrapper.append(svg);
    return wrapper;
  }

  function renderSummaryPanels(overview) {
    renderTotal("#channel-total", overview.total_channels);
    renderTotal("#author-total", overview.total_authors);
    renderTotal("#model-total", (overview.embedding_models || []).length);
    renderCountList("#channel-counts", overview.channels);
    renderCountList("#author-counts", overview.authors);
    renderCountList("#model-counts", overview.embedding_models);
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

  function renderChunks(overview, append) {
    const chunkCards = (overview.chunks || []).map(createDatabaseChunkCard);
    if (!append && !chunkCards.length) {
      chunkCards.push(createEmptyState("Databáze zatím neobsahuje žádné chunky."));
    }
    const chunkList = document.querySelector("#database-chunks");
    append ? chunkList.append(...chunkCards) : chunkList.replaceChildren(...chunkCards);
    const displayed = Number(overview.offset || 0) + (overview.chunks || []).length;
    document.querySelector("#chunk-range").textContent =
      `Zobrazeno ${formatNumber(displayed)} z ${formatNumber(overview.total_chunks)}`;
    document.querySelector("#load-more-chunks-button")
      .classList.toggle("hidden", !overview.has_more);
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

  return { getLatest: () => latestOverview, loadMore, refresh };
})();
