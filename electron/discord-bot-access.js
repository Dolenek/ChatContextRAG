class DiscordBotAccessPolicy {
  constructor(getSettings) {
    this.getSettings = getSettings;
  }

  permits(member, guildId, capability) {
    const settings = this.getSettings();
    const guild = settings?.guilds?.find((item) => item.guild_id === guildId);
    const subjects = guild?.[`${capability}_subjects`] || [];
    if (!subjects.length || !member) return false;
    const userId = member.user?.id || member.id;
    const roleIds = memberRoleIds(member);
    return subjects.some((subject) => subject.subject_type === "user"
      ? subject.subject_id === userId
      : roleIds.has(subject.subject_id));
  }
}

function memberRoleIds(member) {
  if (member.roles?.cache) return new Set(member.roles.cache.keys());
  if (Array.isArray(member.roles)) return new Set(member.roles);
  return new Set();
}

module.exports = { DiscordBotAccessPolicy, memberRoleIds };
