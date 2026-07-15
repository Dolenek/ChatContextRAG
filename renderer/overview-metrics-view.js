window.overviewMetricsView = (() => {
  const numberFormatter = new Intl.NumberFormat("cs-CZ");
  const summaryRows = [];
  const cardDefinitions = [
    {
      title: "Objem dat", icon: "icon-database", tone: "violet",
      rows: [
        row("Chunky", "total_chunks", "icon-layers"),
        row("Zdrojové zprávy", "total_source_messages", "icon-documents"),
        row("Raw zprávy", "raw_message_count", "icon-file-text"),
        row("Unikátní texty", "unique_content_count", "icon-fingerprint"),
        row("Přesné duplicity", "duplicate_message_count", "icon-copy"),
        row("Zaindexované zprávy", "indexed_message_count", "icon-search-index"),
        row("Konverzace", "total_channels", "icon-chat"),
      ],
    },
    {
      title: "Kvalita a indexace", icon: "icon-clock", tone: "violet", progress: true,
      rows: [
        row("Chunky", "total_chunks"),
        row("Zaindexované zprávy", "indexed_message_count"),
        row("Čeká na index", "pending_message_count", null, "number", "attention"),
        row("Přesné duplicity", "duplicate_message_count"),
      ],
    },
    {
      title: "Časový rozsah archivu", icon: "icon-calendar", tone: "violet",
      rows: [
        row("Nejstarší zpráva", "oldest_message_at", "icon-clock", "date"),
        row("Nejnovější zpráva", "newest_message_at", "icon-calendar", "date"),
      ],
    },
  ];
  let bannerParts = null;
  let progressParts = null;

  function row(label, key, icon = null, format = "number", emphasis = "") {
    return { label, key, icon, format, emphasis };
  }

  function initialize() {
    if (bannerParts) return;
    const dashboard = document.querySelector("#overview-summary");
    const banner = createArchiveBanner();
    const cardGrid = element("div", "overview-summary-grid");
    cardGrid.append(...cardDefinitions.map(createSummaryCard));
    dashboard.replaceChildren(banner, cardGrid);
  }

  function createArchiveBanner() {
    const banner = element("article", "overview-archive-banner");
    const archiveState = element("div", "overview-archive-state");
    const icon = createSvgIcon("icon-check", "overview-archive-icon");
    const copy = element("div", "overview-archive-copy");
    const title = element("strong", "", "Stav archivu");
    const description = element("p", "", "Připravuji stav archivu…");
    const summaryState = element("small", "overview-summary-state");
    summaryState.id = "overview-summary-state";
    summaryState.setAttribute("role", "status");
    summaryState.setAttribute("aria-live", "polite");
    copy.append(title, description, summaryState);
    archiveState.append(icon.wrapper, copy);
    const readiness = createBannerMetric("Připravenost archivu", "—", "Připravuji");
    const pending = createBannerMetric("Čeká na index", "—", "zpráv");
    const size = createBannerMetric("Velikost databáze", "—", "Celková velikost");
    banner.append(archiveState, readiness.wrapper, pending.wrapper, size.wrapper);
    bannerParts = { banner, description, iconUse: icon.use, readiness, pending, size };
    return banner;
  }

  function createBannerMetric(labelText, valueText, noteText) {
    const wrapper = element("div", "overview-banner-metric");
    const label = element("span", "", labelText);
    const value = element("strong", "", valueText);
    const note = element("small", "", noteText);
    wrapper.append(label, value, note);
    return { wrapper, value, note };
  }

  function createSummaryCard(definition) {
    const card = element("article", "overview-summary-card overview-metric-summary-card");
    const heading = element("header", "overview-card-heading overview-metric-heading");
    const headingCopy = element("div");
    const icon = createSvgIcon(definition.icon, `overview-heading-icon tone-${definition.tone}`);
    headingCopy.append(icon.wrapper, element("h2", "", definition.title));
    heading.append(headingCopy);
    const rowContainer = element("div", "overview-summary-rows");
    rowContainer.append(...definition.rows.map(createSummaryRow));
    card.append(heading, rowContainer);
    if (definition.progress) card.append(createIndexProgress());
    return card;
  }

  function createSummaryRow(definition) {
    const metricRow = element("div", `overview-summary-row ${definition.emphasis}`.trim());
    const label = element("span", "overview-summary-label");
    if (definition.icon) label.append(createSvgIcon(definition.icon, "overview-row-icon").wrapper);
    label.append(element("span", "", definition.label));
    const value = element("strong", "", "—");
    metricRow.append(label, value);
    summaryRows.push({ definition, metricRow, value });
    return metricRow;
  }

  function createIndexProgress() {
    const section = element("div", "overview-index-progress");
    const labels = element("div", "overview-progress-labels");
    const value = element("strong", "", "—");
    labels.append(element("span", "", "Indexováno"), value);
    const track = element("div", "overview-progress-track");
    const bar = element("span");
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", "Podíl zaindexovaných zpráv");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.append(bar);
    section.append(labels, track);
    progressParts = { value, track, bar };
    return section;
  }

  function createSvgIcon(iconId, className) {
    const wrapper = element("span", className);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    wrapper.setAttribute("aria-hidden", "true");
    use.setAttribute("href", `assets/icon-sprite.svg#${iconId}`);
    svg.append(use);
    wrapper.append(svg);
    return { wrapper, use };
  }

  function element(tagName, className = "", text = "") {
    const createdElement = document.createElement(tagName);
    if (className) createdElement.className = className;
    if (text) createdElement.textContent = text;
    return createdElement;
  }

  function render(status) {
    initialize();
    const readiness = readinessPercent(status);
    updateArchiveBanner(status, readiness);
    summaryRows.forEach((entry) => updateSummaryRow(entry, status));
    updateIndexProgress(readiness);
  }

  function updateArchiveBanner(status, readiness) {
    const archiveState = describeArchive(status, readiness);
    bannerParts.banner.dataset.state = archiveState.name;
    bannerParts.description.textContent = archiveState.description;
    bannerParts.iconUse.setAttribute("href", `assets/icon-sprite.svg#${archiveState.icon}`);
    bannerParts.readiness.value.textContent = readiness === null ? "—" : `${readiness} %`;
    bannerParts.readiness.note.textContent = readinessNote(status, readiness);
    const projectedUnavailable = status.summary_ready === false;
    bannerParts.pending.value.textContent = projectedUnavailable
      ? "—" : formatNumber(status.pending_message_count);
    bannerParts.size.value.textContent = status.database_size || "—";
  }

  function describeArchive(status, readiness) {
    if (status.summary_ready === false) return {
      name: "preparing", icon: "icon-clock",
      description: "Souhrn archivu se právě připravuje.",
    };
    if (!Number(status.raw_message_count || 0)) return {
      name: "empty", icon: "icon-database",
      description: "Archiv je prázdný a čeká na první zprávy.",
    };
    if (readiness === 100 && !Number(status.pending_message_count || 0)) return {
      name: "ready", icon: "icon-check",
      description: "Archiv je kompletní a připraven k dotazování.",
    };
    const active = (status.indexing_jobs || []).some((job) =>
      ["queued", "running"].includes(job.status));
    return {
      name: active ? "indexing" : "pending", icon: "icon-clock",
      description: active ? "Archiv se právě indexuje."
        : "Archiv čeká na dokončení indexace.",
    };
  }

  function readinessNote(status, readiness) {
    if (status.summary_ready === false) return "Připravuji";
    if (readiness === null) return "Bez dat";
    return readiness === 100 ? "Kompletní" : "Probíhá";
  }

  function readinessPercent(status) {
    if (status.summary_ready === false) return null;
    const rawMessages = Number(status.raw_message_count || 0);
    if (!rawMessages) return null;
    const indexedMessages = Number(status.indexed_message_count || 0);
    return Math.min(100, Math.max(0, Math.floor(indexedMessages / rawMessages * 100)));
  }

  function updateSummaryRow(entry, status) {
    const unavailable = status.summary_ready === false;
    const value = unavailable ? undefined : status[entry.definition.key];
    const formatted = entry.definition.format === "date"
      ? formatDate(value) : formatNumber(value);
    entry.value.textContent = formatted;
    entry.metricRow.setAttribute("aria-label", `${entry.definition.label}: ${formatted}`);
  }

  function updateIndexProgress(readiness) {
    const percent = readiness ?? 0;
    progressParts.value.textContent = readiness === null ? "—" : `${readiness} %`;
    progressParts.track.setAttribute("aria-valuenow", String(percent));
    progressParts.bar.style.width = `${percent}%`;
  }

  function formatNumber(value) {
    if (value === null || value === undefined) return "—";
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numberFormatter.format(numericValue) : String(value);
  }

  function formatDate(value) {
    if (!value) return "Bez času";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Bez času" : date.toLocaleString("cs-CZ");
  }

  initialize();
  return { formatDate, formatNumber, initialize, readinessPercent, render };
})();
