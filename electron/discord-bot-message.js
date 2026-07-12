function discordMessageToInput(message) {
  const attachmentLines = [...message.attachments.values()].map((attachment) =>
    `[Příloha] ${attachment.name || "soubor"}`);
  const contentParts = [message.content?.trim(), ...attachmentLines].filter(Boolean);
  const author = message.member?.displayName
    || message.author?.globalName
    || message.author?.username
    || "Neznámý autor";
  return {
    external_id: message.id,
    author,
    content: contentParts.join("\n") || "[Zpráva bez textového obsahu]",
    timestamp: message.createdAt?.toISOString() || new Date().toISOString(),
    channel: message.channel?.name || "Discord kanál",
    channel_id: message.channelId,
    guild_id: message.guildId,
    source_type: "discord",
    conversation_id: message.channelId,
    conversation_label: message.channel?.name || "Discord kanál",
    container_id: message.guildId,
    container_label: message.guild?.name || null,
    source_metadata: {
      edited_timestamp: message.editedAt?.toISOString() || null,
      attachment_count: attachmentLines.length,
    },
  };
}

function discordChannelContext(channel) {
  return {
    guild_id: channel.guildId,
    channel_id: channel.id,
    channel: channel.name || "Discord kanál",
    source_type: "discord",
    conversation_id: channel.id,
    conversation_label: channel.name || "Discord kanál",
    container_id: channel.guildId,
    container_label: channel.guild?.name || null,
  };
}

module.exports = { discordChannelContext, discordMessageToInput };
