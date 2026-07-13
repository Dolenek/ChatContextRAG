const fs = require("node:fs");
const path = require("node:path");

class SecretStore {
  constructor(filePath, encryption) {
    this.filePath = filePath;
    this.encryption = encryption;
  }

  save(secret) {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error("Secure secret storage is unavailable.");
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const encrypted = this.encryption.encryptString(secret.trim());
    writePrivateFile(this.filePath, encrypted.toString("base64"));
  }

  load() {
    if (!fs.existsSync(this.filePath) || !this.encryption.isEncryptionAvailable()) return null;
    const encrypted = Buffer.from(fs.readFileSync(this.filePath, "utf8"), "base64");
    return this.encryption.decryptString(encrypted);
  }

  clear() {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
  }
}

function writePrivateFile(filePath, content) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

module.exports = { SecretStore, writePrivateFile };
