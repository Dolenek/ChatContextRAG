window.overviewMetricsView = (() => {
  const numberFormatter = new Intl.NumberFormat("cs-CZ");
  const groups = [
    ["#overview-stats", "primary", [
      metric("Chunky", "total_chunks", "icon-layers", "blue"),
      metric("Zdrojové zprávy", "total_source_messages", "icon-documents", "violet"),
      metric("Raw zprávy", "raw_message_count", "icon-file-text", "sky"),
      metric("Unikátní texty", "unique_content_count", "icon-fingerprint", "green"),
      metric("Přesné duplicity", "duplicate_message_count", "icon-copy", "amber"),
      metric("Zaindexované zprávy", "indexed_message_count", "icon-search-index", "teal"),
    ]],
    ["#overview-status-stats", "status", [
      metric("Čeká na index", "pending_message_count", "icon-clock", "rose"),
      metric("Velikost databáze", "database_size", "icon-database", "blue", "text"),
      metric("Konverzace", "total_channels", "icon-chat", "violet"),
      metric("Nejstarší zpráva", "oldest_message_at", "icon-calendar", "green", "date"),
      metric("Nejnovější zpráva", "newest_message_at", "icon-calendar", "teal", "date"),
    ]],
  ];
  const cards = new Map();

  function metric(label, key, icon, tone, format = "number") {
    return { label, key, icon, tone, format };
  }

  function initialize() {
    if (cards.size) return;
    groups.forEach(([selector, variant, definitions]) => {
      const groupCards = definitions.map((definition) => createCard(definition, variant));
      document.querySelector(selector).replaceChildren(...groupCards);
    });
  }

  function render(status) {
    initialize();
    groups.forEach(([_selector, _variant, definitions]) => {
      definitions.forEach((definition) => updateCard(definition, status));
    });
  }

  function createCard(definition, variant) {
    const card = document.createElement("article");
    const copy = document.createElement("div");
    const value = document.createElement("strong");
    const label = document.createElement("span");
    card.className = `overview-metric-card overview-${variant}-card tone-${definition.tone}`;
    card.setAttribute("aria-label", `${definition.label}: —`);
    value.textContent = "—";
    label.textContent = definition.label;
    copy.className = "overview-metric-copy";
    copy.append(value, label);
    card.append(createIcon(definition.icon), copy);
    cards.set(definition.key, { card, value, definition });
    return card;
  }

  function createIcon(iconId) {
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

  function updateCard(definition, status) {
    const entry = cards.get(definition.key);
    const unavailable = status.summary_ready === false && definition.key !== "database_size";
    const value = formatValue(definition, unavailable ? undefined : status[definition.key]);
    entry.value.textContent = value;
    entry.card.setAttribute("aria-label", `${definition.label}: ${value}`);
  }

  function formatValue(definition, value) {
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

  initialize();
  return { formatDate, formatNumber, initialize, render };
})();
