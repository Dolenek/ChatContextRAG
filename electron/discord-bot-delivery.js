const DISCORD_MESSAGE_LIMIT = 2_000;

function linkEvidenceCitations(answer, evidence) {
  const links = new Map(evidence.map((item) => [item.evidence_id, evidenceUrl(item)]));
  return answer.replace(/\[E([1-9][0-9]*)\]/g, (citation, number) => {
    const evidenceId = `E${number}`;
    const url = links.get(evidenceId);
    return url ? `[${evidenceId}](${url})` : citation;
  });
}

async function deliverDiscordAnswer(triggerMessage, result) {
  const linked = linkEvidenceCitations(result.answer, result.evidence || []);
  const parts = splitDiscordMessage(linked);
  const sent = [];
  try {
    for (const [index, content] of parts.entries()) {
      const message = index === 0
        ? await triggerMessage.reply({ content, allowedMentions: { repliedUser: false } })
        : await triggerMessage.channel.send({ content, allowedMentions: { parse: [] } });
      sent.push(message.id);
    }
  } catch (error) {
    error.sentMessageIds = [...sent];
    throw error;
  }
  return sent;
}

async function withTyping(channel, operation) {
  await channel.sendTyping().catch(() => {});
  const timer = setInterval(() => channel.sendTyping().catch(() => {}), 8_000);
  timer.unref?.();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

function splitDiscordMessage(content) {
  if (content.length <= DISCORD_MESSAGE_LIMIT) return [content];
  const parts = [];
  let remaining = content;
  while (remaining.length > DISCORD_MESSAGE_LIMIT) {
    const boundary = splitBoundary(remaining);
    parts.push(remaining.slice(0, boundary).trimEnd());
    remaining = remaining.slice(boundary).trimStart();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function splitBoundary(content) {
  const window = content.slice(0, DISCORD_MESSAGE_LIMIT + 1);
  const newline = window.lastIndexOf("\n");
  if (newline >= 1_000) return newline;
  const whitespace = window.lastIndexOf(" ");
  return whitespace >= 1_000 ? whitespace : DISCORD_MESSAGE_LIMIT;
}

function evidenceUrl(evidence) {
  if (!evidence.guild_id || !evidence.channel_id || !evidence.message_id) return null;
  return `https://discord.com/channels/${evidence.guild_id}/${evidence.channel_id}/${evidence.message_id}`;
}

module.exports = {
  deliverDiscordAnswer, evidenceUrl, linkEvidenceCitations, splitDiscordMessage,
  withTyping, DISCORD_MESSAGE_LIMIT,
};
