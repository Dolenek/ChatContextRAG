const { Client, Events, GatewayIntentBits, Partials } = require("discord.js");

function createDiscordBotClient(controller) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });
  client.on(Events.InteractionCreate, (interaction) => void controller.handleInteraction(interaction));
  client.on(Events.MessageCreate, (message) => controller.handleLiveMessage(message));
  client.on(Events.MessageCreate, (message) => controller.handleQuestion(message));
  client.on(Events.MessageUpdate, (_oldMessage, message) => controller.handleLiveMessage(message));
  client.on(Events.Error, (error) => {
    controller.lastError = error.message;
    controller.onProgress({ type: "error", error: error.message });
  });
  return client;
}

module.exports = { createDiscordBotClient };
