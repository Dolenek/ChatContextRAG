const fs = require("node:fs");
const path = require("node:path");
const { writePrivateFile } = require("../runtime/secret-store");

class ArchiveMigrationStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, "chat-context", "archive-migration.json");
  }

  load() {
    if (!fs.existsSync(this.filePath)) return null;
    return JSON.parse(fs.readFileSync(this.filePath, "utf8"));
  }

  save(state) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    writePrivateFile(this.filePath, JSON.stringify(state, null, 2));
    return state;
  }

  clear() {
    if (fs.existsSync(this.filePath)) fs.rmSync(this.filePath);
  }
}

module.exports = { ArchiveMigrationStore };
