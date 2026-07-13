const crypto = require("node:crypto");
const { hashPassword } = require("../web/passwords");

const suppliedPassword = process.env.CHAT_CONTEXT_ADMIN_PASSWORD_INPUT;
const adminPassword = suppliedPassword || crypto.randomBytes(18).toString("base64url");

console.log("# Copy these values into .env and keep that file private.");
console.log("WEB_ADMIN_USERNAME=admin");
console.log(`WEB_ADMIN_PASSWORD_HASH=${hashPassword(adminPassword)}`);
console.log(`CHAT_CONTEXT_SERVER_KEY=${crypto.randomBytes(32).toString("base64")}`);
console.log(`CHAT_CONTEXT_DESKTOP_TOKEN=${crypto.randomBytes(32).toString("base64url")}`);
console.log(`CHAT_CONTEXT_INTERNAL_TOKEN=${crypto.randomBytes(32).toString("base64url")}`);
if (!suppliedPassword) {
  console.log(`# Generated admin password (store it now): ${adminPassword}`);
}
