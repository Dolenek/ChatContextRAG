const { MessageFlags, SlashCommandBuilder } = require("discord.js");
const { discordChannelContext } = require("./discord-bot-message");

class DiscordBotCommands {
  constructor(options) {
    this.getState = options.getState;
    this.refreshState = options.refreshState || (async (id) => this.getState(id));
    this.setState = options.setState;
    this.deleteState = options.deleteState || (() => {});
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
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    try {
      if (!interaction.inGuild()
        || !this.canManage(interaction.member, interaction.guildId)) {
        await interaction.editReply(
          "Pro tento příkaz nemáte oprávnění v nastavení Discord bota.",
        );
        return;
      }
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === "status") return await this.replyWithStatus(interaction);
      if (subcommand === "stop") return await this.stop(interaction);
      return await this.sync(interaction);
    } catch (error) {
      await interaction.editReply(`Příkaz selhal: ${error.message}`);
    }
  }

  async sync(interaction) {
    const existing = this.getState(interaction.channelId) || {};
    const enabledState = this.synchronizer.mergeState(
      discordChannelContext(interaction.channel), existing, { tracking_enabled: true },
    );
    this.setState(interaction.channelId, enabledState);
    try {
      const result = enabledState.backfill_complete
        ? await this.synchronizer.catchUp(interaction.channel, enabledState)
        : await this.synchronizer.syncHistory(interaction.channel, enabledState);
      this.setState(interaction.channelId, result.state);
      await this.refreshState(interaction.channelId);
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
    this.setState(interaction.channelId, state);
    try {
      const saved = await this.saveState(state);
      this.setState(interaction.channelId, saved);
      await interaction.editReply("Živé sledování bylo vypnuto.");
    } catch (error) {
      if (existing.conversation_id) this.setState(interaction.channelId, existing);
      else this.deleteState(interaction.channelId);
      throw error;
    }
  }

  async replyWithStatus(interaction) {
    const state = await this.refreshState(interaction.channelId);
    const text = !state
      ? "Tento kanál zatím není synchronizovaný."
      : `Sledování: ${state.tracking_enabled ? "aktivní" : "vypnuté"} · historie: ${state.backfill_complete ? "kompletní" : "rozpracovaná"} · raw ${state.raw_message_count || 0} · index ${state.indexed_message_count || 0}${state.last_error ? ` · chyba: ${state.last_error}` : ""}`;
    await interaction.editReply(text);
  }
}

module.exports = { DiscordBotCommands };
