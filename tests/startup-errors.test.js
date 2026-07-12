const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { BackendProcess } = require("../electron/backend-process");

test("backend startup failure includes captured stderr", async () => {
  const backend = new BackendProcess(process.cwd());
  backend.process = { exitCode: 2 };
  backend.stderrLines = ["database migration failed"];
  backend.isHealthy = async () => false;

  await assert.rejects(
    backend.waitUntilHealthy(),
    /database migration failed/,
  );
});

test("Electron returns a failure code so run.bat keeps the error visible", () => {
  const main = fs.readFileSync(
    path.resolve(__dirname, "..", "electron", "main.js"), "utf8",
  );

  assert.match(main, /backendProcess\.stop\(\)/);
  assert.match(main, /app\.exit\(1\)/);
});
