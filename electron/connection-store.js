const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFile } = require("../runtime/secret-store");
const {
  assertRemoteTransportSecurity, requiresInsecureHttpAcknowledgement,
} = require("./connection-security");

class ConnectionStore {
  constructor(userDataPath, safeStorage) {
    this.safeStorage = safeStorage;
    this.filePath = path.join(userDataPath, "chat-context", "connection.json");
  }

  getPublic() {
    const state = this.read();
    return {
      mode: state.mode,
      baseUrl: state.baseUrl || "",
      hasToken: Boolean(state.encryptedToken),
      insecureHttpAcknowledged: isInsecureOriginAcknowledged(state),
    };
  }

  getActive() {
    const state = this.read();
    if (state.mode === "local") return { mode: "local" };
    if (!state.encryptedToken) throw new Error("Remote workspace token is missing.");
    return {
      mode: "remote",
      baseUrl: normalizeServerUrl(state.baseUrl),
      token: this.decrypt(state.encryptedToken),
      insecureHttpAcknowledged: isInsecureOriginAcknowledged(state),
    };
  }

  save(input) {
    const existing = this.read();
    if (input.mode === "local") {
      this.write({ ...existing, mode: "local" });
      return this.getPublic();
    }
    const remote = this.prepareRemote(input, existing);
    this.write({ mode: "remote", ...remote });
    return this.getPublic();
  }

  rememberRemote(input) {
    const existing = this.read();
    const remote = this.prepareRemote(input, existing);
    this.write({ ...existing, ...remote, mode: existing.mode });
    return {
      baseUrl: remote.baseUrl,
      hasToken: true,
      insecureHttpAcknowledged: Boolean(remote.acknowledgedInsecureOrigin),
    };
  }

  resolveRemote(input) {
    const existing = this.read();
    const baseUrl = normalizeServerUrl(input.baseUrl || existing.baseUrl);
    const insecureHttpAcknowledged = acknowledgesOrigin(input, existing, baseUrl);
    assertRemoteTransportSecurity(baseUrl, insecureHttpAcknowledged);
    if (input.token?.trim()) {
      return { baseUrl, token: input.token.trim(), insecureHttpAcknowledged };
    }
    if (existing.baseUrl !== baseUrl || !existing.encryptedToken) {
      throw new Error("Remote workspace token is required for this server.");
    }
    return {
      baseUrl,
      token: this.decrypt(existing.encryptedToken),
      insecureHttpAcknowledged,
    };
  }

  prepareRemote(input, existing) {
    const baseUrl = normalizeServerUrl(input.baseUrl);
    const sameServer = existing.baseUrl === baseUrl;
    const encryptedToken = input.token?.trim()
      ? this.encrypt(input.token.trim())
      : sameServer ? existing.encryptedToken : null;
    if (!encryptedToken) throw new Error("Remote workspace token is required.");
    const insecureHttpAcknowledged = acknowledgesOrigin(input, existing, baseUrl);
    assertRemoteTransportSecurity(baseUrl, insecureHttpAcknowledged);
    const acknowledgedInsecureOrigin = insecureHttpAcknowledged ? baseUrl : null;
    return { baseUrl, encryptedToken, acknowledgedInsecureOrigin };
  }

  acknowledgeInsecureOrigin(baseUrl) {
    const existing = this.read();
    const normalizedUrl = normalizeServerUrl(baseUrl);
    if (existing.baseUrl !== normalizedUrl
      || !requiresInsecureHttpAcknowledgement(normalizedUrl)) {
      throw new Error("The stored remote HTTP origin cannot be acknowledged.");
    }
    this.write({ ...existing, acknowledgedInsecureOrigin: normalizedUrl });
    return this.getPublic();
  }

  encrypt(token) {
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("System encryption is unavailable; the token was not saved.");
    }
    if (process.platform === "linux"
      && this.safeStorage.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("Linux plaintext secret storage is not allowed.");
    }
    return this.safeStorage.encryptString(token).toString("base64");
  }

  decrypt(encryptedToken) {
    return this.safeStorage.decryptString(Buffer.from(encryptedToken, "base64"));
  }

  read() {
    if (!fs.existsSync(this.filePath)) return { mode: "local" };
    const state = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    return state.mode === "remote" ? state : { ...state, mode: "local" };
  }

  write(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writePrivateFile(this.filePath, JSON.stringify(state, null, 2));
  }
}

function acknowledgesOrigin(input, existing, baseUrl) {
  if (!requiresInsecureHttpAcknowledgement(baseUrl)) return false;
  return input.insecureHttpAcknowledged === true
    || existing.acknowledgedInsecureOrigin === baseUrl;
}

function isInsecureOriginAcknowledged(state) {
  if (!state.baseUrl) return false;
  const baseUrl = normalizeServerUrl(state.baseUrl);
  return requiresInsecureHttpAcknowledgement(baseUrl)
    && state.acknowledgedInsecureOrigin === baseUrl;
}

function normalizeServerUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    throw new Error("Remote server URL is invalid.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Remote server URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) {
    throw new Error("Remote server URL must not contain credentials, a path, query, or fragment.");
  }
  return url.origin;
}

module.exports = { ConnectionStore, normalizeServerUrl };
