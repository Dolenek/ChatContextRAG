function requireDiscordInviteUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Discord invite URL is invalid.");
  }
  const normalizedPath = url.pathname.replace(/\/$/, "");
  if (url.origin !== "https://discord.com" || url.username || url.password
    || normalizedPath !== "/oauth2/authorize") {
    throw new Error("Discord invite URL is not trusted.");
  }
  return url.href;
}

module.exports = { requireDiscordInviteUrl };
