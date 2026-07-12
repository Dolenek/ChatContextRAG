const { spawn } = require("node:child_process");

const BACKEND_URL = "http://127.0.0.1:8765";

class BackendProcess {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.process = null;
    this.stderrLines = [];
  }

  async start() {
    if (await this.isHealthy()) return;
    this.process = this.spawnPythonService();
    await this.waitUntilHealthy();
  }

  spawnPythonService() {
    this.stderrLines = [];
    const child = spawn(
      "py",
      ["-3.9", "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: this.projectRoot, env: process.env, windowsHide: true },
    );
    child.stderr.on("data", (chunk) => this.captureStderr(chunk));
    return child;
  }

  captureStderr(chunk) {
    const output = chunk.toString();
    this.stderrLines.push(...output.split(/\r?\n/).filter(Boolean));
    this.stderrLines = this.stderrLines.slice(-20);
    console.error(`[backend] ${output}`);
  }

  async waitUntilHealthy() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (await this.isHealthy()) return;
      if (this.process?.exitCode !== null) {
        throw new Error(this.failureMessage("FastAPI backend předčasně skončil"));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    this.stop();
    throw new Error(this.failureMessage("FastAPI backend nenaběhl do 60 sekund"));
  }

  failureMessage(prefix) {
    const detail = this.stderrLines.slice(-8).join("\n");
    return detail ? `${prefix}:\n${detail}` : `${prefix}.`;
  }

  async isHealthy() {
    try {
      const response = await fetch(`${BACKEND_URL}/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  stop() {
    if (this.process && !this.process.killed) this.process.kill();
  }
}

module.exports = { BackendProcess, BACKEND_URL };
