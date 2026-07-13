const fs = require("node:fs");
const path = require("node:path");

class RotatingBackendLog {
  constructor(directory, options = {}) {
    this.directory = directory;
    this.filePath = path.join(directory, "backend.log");
    this.maxBytes = options.maxBytes || 5 * 1024 * 1024;
    this.backups = options.backups || 3;
    this.buffers = new Map();
    this.lastError = null;
  }

  write(streamName, chunk) {
    const buffered = `${this.buffers.get(streamName) || ""}${chunk.toString()}`;
    const lines = buffered.split(/\r?\n/);
    this.buffers.set(streamName, lines.pop());
    lines.forEach((line) => this.append(streamName, line));
  }

  flush() {
    for (const [streamName, line] of this.buffers.entries()) {
      if (line) this.append(streamName, line);
    }
    this.buffers.clear();
  }

  append(streamName, line) {
    const entry = `${new Date().toISOString()} [${streamName}] ${line}\n`;
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      this.rotateIfNeeded(Buffer.byteLength(entry));
      fs.appendFileSync(this.filePath, entry, "utf8");
    } catch (error) {
      this.lastError = error;
    }
  }

  rotateIfNeeded(incomingBytes) {
    const currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    if (currentBytes + incomingBytes <= this.maxBytes) return;
    for (let index = this.backups; index >= 1; index -= 1) {
      this.rotateFile(index);
    }
    if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
  }

  rotateFile(index) {
    const source = `${this.filePath}.${index}`;
    if (!fs.existsSync(source)) return;
    if (index === this.backups) {
      fs.rmSync(source);
      return;
    }
    fs.renameSync(source, `${this.filePath}.${index + 1}`);
  }
}

module.exports = { RotatingBackendLog };
