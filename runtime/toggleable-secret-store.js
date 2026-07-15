const fs = require("node:fs");
const path = require("node:path");

class ToggleableSecretStore {
  constructor(secretStore, stateFilePath) {
    this.secretStore = secretStore;
    this.stateFilePath = stateFilePath;
  }

  save(secret) { return this.secretStore.save(secret); }
  load() { return this.secretStore.load(); }

  clear() {
    this.secretStore.clear();
    if (fs.existsSync(this.stateFilePath)) fs.rmSync(this.stateFilePath);
  }

  isEnabled() {
    if (!fs.existsSync(this.stateFilePath)) return true;
    try {
      return JSON.parse(fs.readFileSync(this.stateFilePath, "utf8")).enabled === true;
    } catch {
      return false;
    }
  }

  setEnabled(enabled) {
    fs.mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
    const temporaryPath = `${this.stateFilePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify({ enabled: Boolean(enabled) }), {
      encoding: "utf8", mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.stateFilePath);
  }
}

module.exports = { ToggleableSecretStore };
