function createChatSourceCard(source) {
  const card = document.createElement("article");
  const heading = document.createElement("div");
  const logo = document.createElement("span");
  const copy = document.createElement("div");
  const title = document.createElement("strong");
  const metadata = document.createElement("small");
  const score = document.createElement("span");
  const content = document.createElement("p");
  const sourcePresentation = presentSource(source);

  card.className = "chat-source-card";
  card.setAttribute("aria-label", "Použité zdroje");
  heading.className = "source-card-heading";
  logo.className = `source-logo ${sourcePresentation.logoClass}`;
  copy.className = "source-card-copy";
  score.className = "source-score";
  logo.textContent = sourcePresentation.shortLabel;
  title.textContent = source.channel || source.conversation_id || sourcePresentation.label;
  metadata.textContent = formatSourceMetadata(source);
  score.textContent = formatSimilarityScore(source.similarity_score);
  content.textContent = source.content || "Zdroj neobsahuje textový náhled.";
  copy.append(title, metadata);
  heading.append(logo, copy, score);
  card.append(heading, content);

  const openButton = createSourceOpenButton(source);
  if (openButton) card.append(openButton);
  return card;
}

function presentSource(source) {
  if (source.source_type === "whatsapp") {
    return { label: "WhatsApp", shortLabel: "W", logoClass: "whatsapp-logo" };
  }
  return { label: "Discord", shortLabel: "D", logoClass: "discord-logo" };
}

function formatSourceMetadata(source) {
  const author = source.author || "Neznámý autor";
  const timestamp = source.timestamp
    ? new Date(source.timestamp).toLocaleString("cs-CZ")
    : "Bez času";
  return `${author} · ${timestamp}`;
}

function formatSimilarityScore(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return "—";
  return score.toLocaleString("cs-CZ", { maximumFractionDigits: 2 });
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
      message_id: messageId,
      channel_id: source.channel_id,
      guild_id: source.guild_id,
    });
    if (result?.embedded !== false) window.shellController.setDiscordActive(true);
  } catch (error) {
    window.appUi?.showToast(error.message, true);
  }
}

window.chatSources = { createChatSourceCard };
