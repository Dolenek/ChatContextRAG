function createChatSources(sources) {
  if (!sources?.length) return null;
  const section = document.createElement("section");
  section.className = "chat-sources";
  const heading = document.createElement("strong");
  heading.className = "chat-sources-heading";
  heading.textContent = "Použité zdroje";
  section.append(heading, ...sources.map(createChatSourceCard));
  return section;
}

function createChatSourceCard(source, index) {
  const details = document.createElement("details");
  details.className = "chat-source-card";
  const summary = document.createElement("summary");
  summary.textContent = `[${index + 1}] ${source.channel || "Bez kanálu"} · ${source.author}`;
  const metadata = document.createElement("small");
  metadata.textContent = source.timestamp
    ? new Date(source.timestamp).toLocaleString("cs-CZ")
    : "Bez času";
  const content = document.createElement("p");
  content.textContent = source.content;
  details.append(summary, metadata, content);
  const openButton = createSourceOpenButton(source);
  if (openButton) details.append(openButton);
  return details;
}

function createSourceOpenButton(source) {
  const messageId = source.source_message_ids?.[0];
  if (!messageId || !source.channel_id || !source.guild_id) return null;
  const button = document.createElement("button");
  button.className = "source-open-button";
  button.type = "button";
  button.textContent = "Otevřít v Discordu";
  button.addEventListener("click", async () => {
    try {
      await window.chatContext.openDiscordSource({
        message_id: messageId,
        channel_id: source.channel_id,
        guild_id: source.guild_id,
      });
    } catch (error) {
      showToast(error.message, true);
    }
  });
  return button;
}

window.chatSources = { createChatSources };
