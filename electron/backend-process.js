const { execFile, spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");

const { BackendClient } = require("../runtime/backend-client");
const { RotatingBackendLog } = require("./backend-log");

const BACKEND_URL = "http://127.0.0.1:8765";

class BackendProcess {
  constructor(projectRoot, options = {}) {
    this.projectRoot = projectRoot;
    this.process = null;
    this.internalToken = crypto.randomBytes(32).toString("hex");
    this.stderrLines = [];
    this.spawnError = null;
    this.lastHealthStatus = null;
    this.healthTimeoutMs = options.healthTimeoutMs || 2_000;
    this.startupTimeoutMs = options.startupTimeoutMs || 60_000;
    const logDirectory = options.logDirectory || path.join(projectRoot, "runtime-logs");
    this.log = options.log || new RotatingBackendLog(logDirectory);
    this.terminateProcess = options.terminateProcess || terminateProcessTree;
  }

  async start() {
    if (await this.isHealthy()) return this.lastHealthStatus || { healthy: true };
    if (this.process) await this.stop();
    this.process = this.spawnPythonService();
    return this.waitUntilHealthy();
  }

  async restart() {
    await this.stop();
    this.process = this.spawnPythonService();
    return this.waitUntilHealthy();
  }

  spawnPythonService() {
    this.stderrLines = [];
    this.spawnError = null;
    const child = spawn(
      "py",
      ["-3.9", "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8765"],
      {
        cwd: this.projectRoot,
        env: { ...process.env, CHAT_CONTEXT_INTERNAL_TOKEN: this.internalToken },
        windowsHide: true,
      },
    );
    this.attachOutput(child);
    this.log.write("process", Buffer.from(`spawned pid=${child.pid || "unknown"}\n`));
    return child;
  }

  attachOutput(child) {
    child.stdout.on("data", (chunk) => this.captureOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => this.captureOutput("stderr", chunk));
    child.once("error", (error) => {
      this.spawnError = error;
      this.captureOutput("stderr", Buffer.from(`${error.message}\n`));
    });
    child.once("exit", (code, signal) => {
      this.log.write("process", Buffer.from(`exited code=${code} signal=${signal || "none"}\n`));
      this.log.flush();
    });
  }

  captureOutput(streamName, chunk) {
    this.log.write(streamName, chunk);
    if (streamName !== "stderr") return;
    const output = chunk.toString();
    this.stderrLines.push(...output.split(/\r?\n/).filter(Boolean));
    this.stderrLines = this.stderrLines.slice(-20);
    console.error(`[backend] ${output}`);
  }

  async waitUntilHealthy() {
    const deadline = Date.now() + this.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await this.isHealthy(Math.min(1_000, this.healthTimeoutMs))) {
        return this.lastHealthStatus || { healthy: true };
      }
      this.assertProcessRunning();
      await wait(250);
    }
    await this.stop();
    throw new Error(this.failureMessage("FastAPI backend nenaběhl do 60 sekund"));
  }

  assertProcessRunning() {
    if (this.spawnError) {
      throw new Error(this.failureMessage("FastAPI backend se nepodařilo spustit"));
    }
    if (this.process?.exitCode !== null) {
      throw new Error(this.failureMessage("FastAPI backend předčasně skončil"));
    }
  }

  failureMessage(prefix) {
    const detail = this.stderrLines.slice(-8).join("\n");
    return detail ? `${prefix}:\n${detail}` : `${prefix}.`;
  }

  async checkHealth(timeoutMs = this.healthTimeoutMs) {
    const checkedAt = new Date().toISOString();
    try {
      await new BackendClient(BACKEND_URL, {}, { timeoutMs }).get("/health");
      this.lastHealthStatus = { healthy: true, endpoint: `${BACKEND_URL}/health`, checkedAt };
    } catch (error) {
      this.lastHealthStatus = {
        healthy: false, endpoint: `${BACKEND_URL}/health`, checkedAt, error: error.message,
      };
    }
    return this.lastHealthStatus;
  }

  async isHealthy(timeoutMs = this.healthTimeoutMs) {
    return (await this.checkHealth(timeoutMs)).healthy;
  }

  async recoverAfterTimeout(timeoutError) {
    const health = await this.checkHealth(1_000);
    const result = { health, timeoutEndpoint: timeoutError.endpoint, restarted: false };
    if (health.healthy) return result;
    await this.restart();
    return {
      ...result,
      restarted: true,
      recoveredHealth: this.lastHealthStatus,
      restartedAt: new Date().toISOString(),
    };
  }

  async stop() {
    const child = this.process;
    this.process = null;
    if (!child || child.exitCode !== null) return;
    this.log.write("process", Buffer.from(`terminating pid=${child.pid || "unknown"}\n`));
    await this.terminateProcess(child);
    this.log.flush();
  }
}

function terminateProcessTree(child) {
  if (process.platform !== "win32" || !child.pid) {
    child.kill();
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], (error) => {
      if (error && !child.killed) child.kill();
      resolve();
    });
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { BackendProcess, BACKEND_URL, terminateProcessTree };
