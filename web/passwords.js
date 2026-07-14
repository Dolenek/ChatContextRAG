const crypto = require("node:crypto");

const scryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function hashPassword(password, salt = crypto.randomBytes(16)) {
  if (!password || password.length < 12) {
    throw new Error("Admin password must contain at least 12 characters.");
  }
  const hash = crypto.scryptSync(password, salt, 32, scryptOptions);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

async function verifyPassword(password, encodedHash) {
  const [algorithm, saltValue, hashValue] = String(encodedHash).split(":");
  if (algorithm !== "scrypt" || !saltValue || !hashValue) return false;
  try {
    const salt = Buffer.from(saltValue, "base64url");
    const expected = Buffer.from(hashValue, "base64url");
    if (!salt.length || !expected.length) return false;
    const actual = await scrypt(password, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function scrypt(password, salt, length) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, length, scryptOptions, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

module.exports = { hashPassword, verifyPassword };
