const crypto = require("node:crypto");
const { hashPassword } = require("../web/passwords");

const suppliedPassword = process.env.CHAT_CONTEXT_ADMIN_PASSWORD_INPUT;
const adminPassword = suppliedPassword || crypto.randomBytes(18).toString("base64url");
const postgresPassword = crypto.randomBytes(32).toString("base64url");
const postgresUser = process.env.POSTGRES_USER || "chat_context";
const postgresDatabase = process.env.POSTGRES_DB || "chat_context";
const postgresPort = process.env.POSTGRES_PORT || "5433";

console.log("# Copy these values into .env and keep that file private.");
console.log(`POSTGRES_PASSWORD=${postgresPassword}`);
console.log(
  `POSTGRES_DSN=postgresql://${postgresUser}:${postgresPassword}`
  + `@127.0.0.1:${postgresPort}/${postgresDatabase}`,
);
console.log("WEB_ADMIN_USERNAME=admin");
console.log(`WEB_ADMIN_PASSWORD_HASH=${hashPassword(adminPassword)}`);
console.log(`CHAT_CONTEXT_SERVER_KEY=${crypto.randomBytes(32).toString("base64")}`);
console.log(`CHAT_CONTEXT_DESKTOP_TOKEN=${crypto.randomBytes(32).toString("base64url")}`);
console.log(`CHAT_CONTEXT_INTERNAL_TOKEN=${crypto.randomBytes(32).toString("base64url")}`);
if (!suppliedPassword) {
  console.log(`# Generated admin password (store it now): ${adminPassword}`);
}
