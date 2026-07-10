const { spawn } = require("node:child_process");

const BACKEND_URL = "http://127.0.0.1:8765";

class BackendProcess {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
    this.process = null;
  }

  async start() {
    if (await this.isHealthy()) return;
    this.process = this.spawnPythonService();
    await this.waitUntilHealthy();
  }

  spawnPythonService() {
    const child = spawn(
      "py",
      ["-3.9", "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8765"],
      { cwd: this.projectRoot, env: process.env, windowsHide: true },
    );
    child.stderr.on("data", (chunk) => console.error(`[backend] ${chunk}`));
    return child;
  }

  async waitUntilHealthy() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await this.isHealthy()) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("FastAPI backend se nepodařilo spustit.");
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
