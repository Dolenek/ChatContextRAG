const path = require("node:path");

function loadWebConfig(environment = process.env) {
  const required = {
    adminPasswordHash: environment.WEB_ADMIN_PASSWORD_HASH,
    serverKey: environment.CHAT_CONTEXT_SERVER_KEY,
    desktopToken: environment.CHAT_CONTEXT_DESKTOP_TOKEN,
    internalToken: environment.CHAT_CONTEXT_INTERNAL_TOKEN,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) throw new Error(`Missing web configuration: ${missing.join(", ")}`);
  return {
    ...required,
    adminUsername: environment.WEB_ADMIN_USERNAME || "admin",
    apiUrl: environment.CHAT_CONTEXT_API_URL || "http://api:8765",
    bindAddress: environment.WEB_BIND_ADDRESS || "0.0.0.0",
    port: parsePort(environment.WEB_PORT || "8080"),
    projectRoot: path.resolve(__dirname, ".."),
    sessionHours: parsePositive(environment.WEB_SESSION_HOURS || "12", "WEB_SESSION_HOURS"),
    stateDirectory: environment.CHAT_CONTEXT_STATE_DIR || "/var/lib/chat-context",
    trustProxy: environment.WEB_TRUST_PROXY === "1",
  };
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("WEB_PORT must be an integer from 1 to 65535.");
  }
  return port;
}

function parsePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be positive.`);
  return number;
}

module.exports = { loadWebConfig };
