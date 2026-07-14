let sourceChunkSequence = 0;

function createChatSourceCard(source, options = {}) {
  const card = document.createElement("article");
  card.className = `chat-source-card ${options.mode === "detail" ? "source-detail-card" : ""}`;
  card.setAttribute("aria-label", `Použitý zdroj ${options.index || 1}`);
  card.append(createSourceHeading(source, options.index || 1));

  const author = document.createElement("strong");
  const content = document.createElement("p");
  author.className = `source-author accent-${authorAccent(source.author)}`;
  author.textContent = source.author || "Neznámý autor";
  content.textContent = source.content || "Zdroj neobsahuje textový náhled.";
  card.append(author, content);

  const chunk = source.chunk ? createChunk(source.chunk) : null;
  card.append(createSourceFooter(source, chunk, options.onLayoutChange));
  if (chunk) card.append(chunk.panel);
  return card;
}

function createSourceHeading(source, index) {
  const heading = document.createElement("div");
  const rank = document.createElement("span");
  const service = document.createElement("span");
  const copy = document.createElement("span");
  const timestamp = document.createElement("time");
  const presentation = presentSource(source);
  heading.className = "source-card-heading";
  rank.className = "source-rank";
  service.className = `source-service ${presentation.logoClass}`;
  copy.className = "source-card-copy";
  timestamp.className = "source-timestamp";
  rank.textContent = String(index);
  service.append(createBrandIcon(source.source_type));
  copy.append(createStrong(presentation.label), createSmall("·"),
    createStrong(source.channel || "Neznámá konverzace"));
  timestamp.textContent = formatSourceTimestamp(source.timestamp);
  heading.append(rank, service, copy, timestamp);
  return heading;
}

function createSourceFooter(source, chunk, onLayoutChange) {
  const footer = document.createElement("div");
  footer.className = "source-card-footer";
  footer.append(source.evidence_origin === "context"
    ? createContextOrigin() : createMatchScore(source));
  if (chunk) footer.append(createChunkToggle(chunk, onLayoutChange));
  return footer;
}

function createContextOrigin() {
  const origin = document.createElement("span");
  origin.className = "source-match-score";
  origin.textContent = "Okolní kontext";
  origin.title = "Zpráva načtená jako okolí nalezeného výsledku; nemá vlastní skóre shody.";
  return origin;
}

function createMatchScore(source) {
  const match = document.createElement("span");
  const relative = formatMatchScore(source.match_score);
  const explanation = `${relative}. ${formatRawScore(source)}`;
  match.className = "source-match-score";
  match.textContent = `Shoda ${relative}`;
  match.tabIndex = 0;
  match.title = `Relativní shoda ${explanation}`;
  match.dataset.tooltip = match.title;
  match.setAttribute("aria-label", match.title);
  return match;
}

function createChunk(chunk) {
  const panel = document.createElement("div");
  const label = document.createElement("strong");
  const content = document.createElement("pre");
  panel.id = `source-chunk-${++sourceChunkSequence}`;
  panel.className = "source-chunk";
  panel.hidden = true;
  label.textContent = chunk.origin === "reconstructed"
    ? "Aktuální chunk – původní nebyl uložen" : "Použitý chunk";
  content.textContent = chunk.content || "";
  panel.append(label, content);
  return { panel };
}

function createChunkToggle(chunk, onLayoutChange) {
  const button = document.createElement("button");
  button.className = "source-chunk-toggle";
  button.type = "button";
  button.textContent = "Zobrazit chunk";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", chunk.panel.id);
  button.addEventListener("click", () => {
    const isOpen = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!isOpen));
    button.textContent = isOpen ? "Zobrazit chunk" : "Skrýt chunk";
    chunk.panel.hidden = isOpen;
    onLayoutChange?.();
  });
  return button;
}

function formatMatchScore(value) {
  const normalized = Math.min(1, Math.max(0, Number(value) || 0));
  return normalized.toLocaleString("cs-CZ", {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function formatRawScore(source) {
  const labels = { rrf: "Raw RRF", cosine: "Raw cosine", unknown: "Raw skóre" };
  const value = Number(source.similarity_score) || 0;
  return `${labels[source.score_kind] || labels.unknown}: ${value.toLocaleString("cs-CZ", {
    minimumFractionDigits: 5, maximumFractionDigits: 5,
  })}`;
}

function createStrong(text) {
  const element = document.createElement("strong");
  element.textContent = text;
  return element;
}

function createSmall(text) {
  const element = document.createElement("small");
  element.textContent = text;
  return element;
}

function presentSource(source) {
  return source.source_type === "whatsapp"
    ? { label: "WhatsApp", logoClass: "whatsapp-logo" }
    : { label: "Discord", logoClass: "discord-logo" };
}

function createBrandIcon(sourceType) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  const iconName = sourceType === "whatsapp" ? "whatsapp" : "discord";
  svg.classList.add("brand-icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `assets/icon-sprite.svg#icon-${iconName}`);
  svg.append(use);
  return svg;
}

function formatSourceTimestamp(value) {
  if (!value) return "Bez času";
  return new Date(value).toLocaleString("cs-CZ", {
    day: "numeric", month: "numeric", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function authorAccent(author = "") {
  let hash = 0;
  for (const character of author) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash % 4;
}

window.chatSources = {
  createBrandIcon, createChatSourceCard, formatMatchScore, formatSourceTimestamp,
};
