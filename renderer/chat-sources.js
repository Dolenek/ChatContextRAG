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

  const openButton = options.mode === "detail" ? createSourceOpenButton(source) : null;
  if (openButton) card.append(createActions(openButton));
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
  copy.append(createStrong(presentation.label), createSmall("·"), createStrong(source.channel || "Neznámá konverzace"));
  timestamp.textContent = formatSourceTimestamp(source.timestamp);
  heading.append(rank, service, copy, timestamp);
  return heading;
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

function createActions(button) {
  const actions = document.createElement("div");
  actions.className = "source-card-actions";
  actions.append(button);
  return actions;
}

function presentSource(source) {
  if (source.source_type === "whatsapp") {
    return { label: "WhatsApp", logoClass: "whatsapp-logo" };
  }
  return { label: "Discord", logoClass: "discord-logo" };
}

function createBrandIcon(sourceType) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  const iconName = sourceType === "whatsapp" ? "whatsapp" : "discord";
  svg.classList.add("brand-icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `#icon-${iconName}`);
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

function createSourceOpenButton(source) {
  if (source.source_type && source.source_type !== "discord") return null;
  const messageId = source.source_message_ids?.[0];
  if (!messageId || !source.channel_id || !source.guild_id) return null;
  const button = document.createElement("button");
  button.className = "source-open-button";
  button.type = "button";
  button.textContent = "Otevřít v Discordu";
  button.addEventListener("click", () => openDiscordSource(source, messageId));
  return button;
}

async function openDiscordSource(source, messageId) {
  try {
    const result = await window.chatContext.openDiscordSource({
      message_id: messageId, channel_id: source.channel_id, guild_id: source.guild_id,
    });
    if (result?.embedded !== false) window.shellController.setDiscordActive(true);
  } catch (error) {
    window.appUi?.showToast(error.message, true);
  }
}

window.chatSources = { createBrandIcon, createChatSourceCard, formatSourceTimestamp };
