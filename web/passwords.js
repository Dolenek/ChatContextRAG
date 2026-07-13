const crypto = require("node:crypto");

const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  if (!password || password.length < 12) {
    throw new Error("Admin password must contain at least 12 characters.");
  }
  const hash = crypto.scryptSync(password, salt, 32, scryptOptions);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

function verifyPassword(password, encodedHash) {
  const [algorithm, saltValue, hashValue] = String(encodedHash).split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    const actual = crypto.scryptSync(password, salt, expected.length, scryptOptions);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
