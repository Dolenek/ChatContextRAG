const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { discordChannelContext } = require("./discord-bot-message");

class DiscordBotCommands {
  constructor(options) {
    this.getState = options.getState;
    this.setState = options.setState;
    this.saveState = options.saveState;
    this.synchronizer = options.synchronizer;
    this.canManage = options.canManage || (() => false);
  }

  async register(client) {
    const command = new SlashCommandBuilder()
      .setName("chatcontext")
      .setDescription("Synchronizace kanálu do lokální Chat Context databáze")
      .setDMPermission(false)
      .addSubcommand((item) => item.setName("sync").setDescription("Načte a sleduje tento kanál"))
      .addSubcommand((item) => item.setName("status").setDescription("Zobrazí stav tohoto kanálu"))
      .addSubcommand((item) => item.setName("stop").setDescription("Ukončí sledování tohoto kanálu"));
    await client.application.commands.set([command.toJSON()]);
  }

  async handle(interaction) {
    if (!interaction.isChatInputCommand() || interaction.commandName !== "chatcontext") return;
    if (!interaction.inGuild()
      || !this.canManage(interaction.member, interaction.guildId)) {
      await interaction.reply({
        content: "Pro tento příkaz nemáte oprávnění v nastavení Discord bota.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === "status") return this.replyWithStatus(interaction);
    if (subcommand === "stop") return this.stop(interaction);
    return this.sync(interaction);
  }

  async sync(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      const existing = this.getState(interaction.channelId) || {};
      const result = existing.backfill_complete
        ? await this.synchronizer.catchUp(interaction.channel, existing)
        : await this.synchronizer.syncHistory(interaction.channel, existing);
      this.setState(interaction.channelId, result.state);
      await interaction.editReply(
        `Synchronizace dokončena: ${result.imported} zpráv. Živé sledování je aktivní.`,
      );
    } catch (error) {
      await interaction.editReply(`Synchronizace selhala: ${error.message}`);
    }
  }

  async stop(interaction) {
    const context = discordChannelContext(interaction.channel);
    const existing = this.getState(interaction.channelId) || {};
    const state = this.synchronizer.mergeState(
      context, existing, { tracking_enabled: false },
    );
    await this.saveState(state);
    await interaction.reply({ content: "Živé sledování bylo vypnuto.", flags: MessageFlags.Ephemeral });
  }

  async replyWithStatus(interaction) {
    const state = this.getState(interaction.channelId);
    const text = !state
      ? "Tento kanál zatím není synchronizovaný."
      : `Sledování: ${state.tracking_enabled ? "aktivní" : "vypnuté"} · historie: ${state.backfill_complete ? "kompletní" : "rozpracovaná"} · raw ${state.raw_message_count || 0} · index ${state.indexed_message_count || 0}${state.last_error ? ` · chyba: ${state.last_error}` : ""}`;
    await interaction.reply({ content: text, flags: MessageFlags.Ephemeral });
  }
}

module.exports = { DiscordBotCommands };
