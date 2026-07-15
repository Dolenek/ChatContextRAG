const { PermissionFlagsBits } = require("discord.js");

function discordBotInviteUrl(client) {
  if (!client?.isReady()) throw new Error("Nejdřív připojte Discord bota.");
  return client.generateInvite({
    scopes: ["bot", "applications.commands"],
    permissions: [
      PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory,
      PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads,
      PermissionFlagsBits.AddReactions,
    ],
  });
}

function discordBotStatus(controller) {
  const states = [...controller.states.values()];
  return {
    connected: Boolean(controller.client?.isReady()),
    hasToken: controller.hasStoredToken,
    enabled: controller.enabled,
    botName: controller.client?.user?.tag || null,
    trackedChannels: states.filter((state) => state.tracking_enabled).length,
    rawMessages: sum(states, "raw_message_count"),
    indexedMessages: sum(states, "indexed_message_count"),
    lastError: controller.lastError,
  };
}

function sum(states, field) {
  return states.reduce((total, state) => total + (state[field] || 0), 0);
}

module.exports = { discordBotInviteUrl, discordBotStatus };
