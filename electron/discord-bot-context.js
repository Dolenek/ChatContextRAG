const MAX_RECENT_MESSAGES = 10;
const MAX_RECENT_CHARACTERS = 8_000;
const MAX_RECENT_AGE_MS = 30 * 60 * 1_000;

async function detectQuestionTrigger(message, botId) {
  if (!message.guildId || !botId || message.author?.bot) return null;
  const mentioned = message.mentions?.users?.has?.(botId)
    || new RegExp(`<@!?${escapeRegex(botId)}>`).test(message.content || "");
  const referenced = message.reference?.messageId
    ? await fetchReferencedMessage(message) : null;
  const repliedToBot = referenced?.author?.id === botId;
  if (!mentioned && !repliedToBot) return null;
  return {
    triggerType: repliedToBot ? "reply" : "mention",
    replyToMessageId: repliedToBot ? referenced.id : null,
    question: stripBotMention(message.content || "", botId),
  };
}

async function loadRecentDiscordContext(message, botId) {
  const collection = await message.channel.messages.fetch({
    limit: 100, before: message.id,
  });
  const cutoff = message.createdTimestamp - MAX_RECENT_AGE_MS;
  const newestFirst = [...collection.values()]
    .filter((item) => item.createdTimestamp >= cutoff && item.author?.id !== botId)
    .sort((left, right) => right.createdTimestamp - left.createdTimestamp);
  return selectWithinBudget(newestFirst, message).reverse();
}

function selectWithinBudget(messages, trigger = {}) {
  const selected = [];
  for (const message of messages) {
    if (selected.length >= MAX_RECENT_MESSAGES) break;
    const candidate = recentMessage(message, trigger);
    if (!selected.length && serializedLength([candidate]) > MAX_RECENT_CHARACTERS) {
      selected.push(truncatedMessage(candidate));
      break;
    }
    if (serializedLength([...selected, candidate]) > MAX_RECENT_CHARACTERS) continue;
    selected.push(candidate);
  }
  return selected;
}

function recentMessage(message, trigger) {
  return {
    message_id: message.id,
    author: displayName(message),
    content: normalizedContent(message),
    timestamp: message.createdAt?.toISOString() || new Date(message.createdTimestamp).toISOString(),
    channel_id: trigger.channelId || message.channelId || "unknown",
    guild_id: trigger.guildId || message.guildId || "unknown",
  };
}

function normalizedContent(message) {
  const attachments = [...(message.attachments?.values?.() || [])]
    .map((attachment) => `[Attachment] ${attachment.name || "file"}`);
  return [message.content?.trim(), ...attachments].filter(Boolean).join("\n")
    || "[Message without text]";
}

function displayName(message) {
  return message.member?.displayName || message.author?.globalName
    || message.author?.username || "Unknown author";
}

async function fetchReferencedMessage(message) {
  try {
    return await message.channel.messages.fetch(message.reference.messageId);
  } catch (_error) {
    return null;
  }
}

function stripBotMention(content, botId) {
  return content.replace(new RegExp(`<@!?${escapeRegex(botId)}>`, "g"), " ")
    .replace(/\s+/g, " ").trim();
}

function truncatedMessage(message) {
  const suffix = "\n[Content truncated]";
  const overhead = serializedLength([{ ...message, content: suffix }]);
  const limit = Math.max(0, MAX_RECENT_CHARACTERS - overhead);
  return { ...message, content: message.content.slice(0, limit) + suffix };
}

function serializedLength(messages) { return JSON.stringify(messages).length; }

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  detectQuestionTrigger, loadRecentDiscordContext, selectWithinBudget,
  serializedLength, MAX_RECENT_MESSAGES, MAX_RECENT_CHARACTERS, MAX_RECENT_AGE_MS,
};
