const crypto = require("node:crypto");

class AesGcmStorage {
  constructor(encodedKey) {
    this.key = decodeKey(encodedKey);
  }

  isEncryptionAvailable() {
    return true;
  }

  encryptString(plaintext) {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
  }

  decryptString(payload) {
    if (payload[0] !== 1 || payload.length < 30) throw new Error("Invalid encrypted secret.");
    const nonce = payload.subarray(1, 13);
    const tag = payload.subarray(13, 29);
    const ciphertext = payload.subarray(29);
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}

function decodeKey(encodedKey) {
  const key = Buffer.from(String(encodedKey), "base64");
  if (key.length !== 32) {
    throw new Error("CHAT_CONTEXT_SERVER_KEY must be a base64-encoded 32-byte key.");
  }
  return key;
}

module.exports = { AesGcmStorage };
