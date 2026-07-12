const fs = require("node:fs");
const path = require("node:path");
const { app, safeStorage } = require("electron");

class DiscordBotTokenStore {
  constructor() {
    this.filePath = path.join(app.getPath("userData"), "discord-bot-token.enc");
  }

  save(token) {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("Operační systém neposkytuje bezpečné úložiště pro Discord token.");
    }
    const encrypted = safeStorage.encryptString(token.trim());
    fs.writeFileSync(this.filePath, encrypted.toString("base64"), {
      encoding: "utf8", mode: 0o600,
    });
  }

  load() {
    if (!fs.existsSync(this.filePath) || !safeStorage.isEncryptionAvailable()) return null;
    const encrypted = Buffer.from(fs.readFileSync(this.filePath, "utf8"), "base64");
    return safeStorage.decryptString(encrypted);
  }

  clear() {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
  }
}

module.exports = { DiscordBotTokenStore };
