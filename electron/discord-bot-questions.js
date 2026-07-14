const { DiscordBotAccessPolicy } = require("./discord-bot-access");
const {
  detectQuestionTrigger, loadRecentDiscordContext,
} = require("./discord-bot-context");
const { deliverDiscordAnswer, withTyping } = require("./discord-bot-delivery");
const { DiscordBotQuestionQueue } = require("./discord-bot-queue");

class DiscordBotQuestionHandler {
  constructor(options) {
    this.api = options.api;
    this.getSettings = options.getSettings;
    this.onProgress = options.onProgress || (() => {});
    this.access = options.access || new DiscordBotAccessPolicy(this.getSettings);
    this.queue = options.queue || new DiscordBotQuestionQueue();
  }

  async handle(message, botId) {
    const trigger = await detectQuestionTrigger(message, botId);
    if (!trigger) return false;
    if (!this.access.permits(message.member, message.guildId, "ask")) {
      await safeReaction(message, "🚫");
      return true;
    }
    if (trigger.question.length < 2) {
      await safeReply(message, "Za zmínku napište otázku alespoň o dvou znacích.");
      return true;
    }
    const capture = await this.captureContext(message, botId);
    const request = answerRequest(message, trigger, capture);
    const operation = () => this.process(message, request);
    const userKey = `${message.guildId}:${message.author.id}`;
    const state = this.queue.submit(message.channelId, userKey, operation);
    await this.reflectQueueState(message, state);
    return true;
  }

  async captureContext(message, botId) {
    try {
      return { recentContext: await loadRecentDiscordContext(message, botId), warnings: [] };
    } catch (_error) {
      return { recentContext: [], warnings: ["recent_context_unavailable"] };
    }
  }

  async process(message, request) {
    let result;
    try {
      result = await withTyping(
        message.channel, () => this.api.answerDiscordQuestion(request),
      );
    } catch (error) {
      await this.reportFailure(message, error);
      return;
    }
    let messageIds = [];
    try {
      messageIds = await deliverDiscordAnswer(message, result);
      await this.api.recordDiscordAnswerDelivery(result.answer_id, {
        status: "delivered", message_ids: messageIds,
      });
      this.onProgress({
        type: "answer", conversationId: message.channelId,
        answerId: result.answer_id,
      });
    } catch (error) {
      if (messageIds.length) await this.retryDeliveryConfirmation(result.answer_id, messageIds);
      else await this.recordDeliveryFailure(result.answer_id, error);
      await this.reportFailure(message, error, messageIds.length === 0);
    }
  }

  async retryDeliveryConfirmation(answerId, messageIds) {
    try {
      await this.api.recordDiscordAnswerDelivery(answerId, {
        status: "delivered", message_ids: messageIds,
        warning: "delivery_confirmation_retried",
      });
    } catch (_auditError) { /* The answer is already visible in Discord. */ }
  }

  async recordDeliveryFailure(answerId, error) {
    try {
      await this.api.recordDiscordAnswerDelivery(answerId, {
        status: "failed", message_ids: error.sentMessageIds || [],
        warning: "discord_delivery_failed",
      });
    } catch (_auditError) {
      // The original delivery error remains the user-facing failure.
    }
  }

  async reportFailure(message, error, shouldReply = true) {
    this.onProgress({
      type: "error", conversationId: message.channelId, error: error.message,
    });
    if (shouldReply) {
      await safeReply(
        message, "Odpověď se teď nepodařilo vytvořit. Zkuste to prosím později.",
      );
    }
  }

  async reflectQueueState(message, state) {
    if (state === "queued") await safeReaction(message, "⏳");
    if (state === "cooldown") await safeReaction(message, "⏱️");
    if (state === "full") await safeReaction(message, "🚫");
  }
}

function answerRequest(message, trigger, capture) {
  return {
    guild_id: message.guildId,
    guild_name: message.guild?.name || "Discord server",
    channel_id: message.channelId,
    channel_name: message.channel?.name || "Discord channel",
    requester_id: message.author.id,
    requester_name: message.member?.displayName || message.author.globalName
      || message.author.username,
    trigger_message_id: message.id,
    trigger_type: trigger.triggerType,
    trigger_at: message.createdAt?.toISOString() || new Date().toISOString(),
    reply_to_message_id: trigger.replyToMessageId,
    question: trigger.question,
    recent_context: capture.recentContext,
    warnings: capture.warnings,
  };
}

async function safeReaction(message, emoji) {
  try { await message.react(emoji); } catch (_error) { /* Missing reaction permission. */ }
}

async function safeReply(message, content) {
  try {
    await message.reply({ content, allowedMentions: { repliedUser: false } });
  } catch (_error) { /* Missing send permission. */ }
}

module.exports = { DiscordBotQuestionHandler, answerRequest, safeReaction };
