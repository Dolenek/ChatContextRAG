class DiscordBotDirectory {
  constructor(options) {
    this.api = options.api;
    this.getClient = options.getClient;
    this.persisted = { model: {}, guilds: [] };
  }

  current() {
    return this.persisted;
  }

  async refresh() {
    this.persisted = await this.api.getDiscordBotSettings();
    return this.view();
  }

  view() {
    return { ...this.persisted, available_guilds: this.availableGuilds() };
  }

  async updateModel(model) {
    this.persisted.model = await this.api.updateDiscordBotModel(model);
    return this.persisted.model;
  }

  async updatePermissions(permissions) {
    const saved = await this.api.updateDiscordGuildPermissions(permissions);
    const index = this.persisted.guilds.findIndex(
      (item) => item.guild_id === saved.guild_id,
    );
    if (index >= 0) this.persisted.guilds[index] = saved;
    else this.persisted.guilds.push(saved);
    return saved;
  }

  availableGuilds() {
    const client = this.getClient();
    if (!client?.isReady()) return [];
    return [...client.guilds.cache.values()]
      .map((guild) => ({ guild_id: guild.id, guild_name: guild.name }))
      .sort((left, right) => left.guild_name.localeCompare(right.guild_name));
  }

  async roles(guildId) {
    const guild = await this.requireGuild(guildId);
    const roles = await guild.roles.fetch();
    return [...roles.values()]
      .filter((role) => !role.managed)
      .map((role) => ({ subject_id: role.id, display_name: role.name }))
      .sort((left, right) => left.display_name.localeCompare(right.display_name));
  }

  async members(guildId, query) {
    const normalized = query?.trim();
    if (!normalized) return [];
    if (normalized.length > 100) throw new Error("Vyhledávání člena je příliš dlouhé.");
    const guild = await this.requireGuild(guildId);
    const members = await guild.members.search({ query: normalized, limit: 25 });
    return [...members.values()].map((member) => ({
      subject_id: member.id,
      display_name: member.displayName || member.user.globalName || member.user.username,
    }));
  }

  async subjectAvailability(guildId, subjects) {
    validateSubjects(subjects);
    const guild = await this.requireGuild(guildId);
    const roles = await guild.roles.fetch();
    const userIds = subjects.filter((subject) => subject.subject_type === "user")
      .map((subject) => subject.subject_id);
    const members = userIds.length
      ? await guild.members.fetch({ user: userIds }).catch(() => guild.members.cache)
      : new Map();
    return subjects.map((subject) => ({
      subject_id: subject.subject_id, subject_type: subject.subject_type,
      available: subject.subject_type === "role"
        ? roles.has(subject.subject_id) : members.has(subject.subject_id),
    }));
  }

  async requireGuild(guildId) {
    const client = this.getClient();
    if (!client?.isReady()) throw new Error("Discord bot není připojený.");
    const guild = client.guilds.cache.get(guildId) || await client.guilds.fetch(guildId);
    if (!guild) throw new Error("Discord server není dostupný.");
    return guild;
  }
}

function validateSubjects(subjects) {
  if (!Array.isArray(subjects) || subjects.length > 1_000) {
    throw new Error("Neplatný seznam Discord oprávnění.");
  }
  const valid = subjects.every((subject) =>
    ["role", "user"].includes(subject?.subject_type)
    && typeof subject.subject_id === "string"
    && subject.subject_id.length > 0 && subject.subject_id.length <= 128);
  if (!valid) throw new Error("Neplatný Discord subjekt oprávnění.");
}

module.exports = { DiscordBotDirectory, validateSubjects };
