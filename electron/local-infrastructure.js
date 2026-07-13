const { spawn } = require("node:child_process");

class LocalInfrastructure {
  constructor(projectRoot) {
    this.projectRoot = projectRoot;
  }

  ensureDatabase() {
    return new Promise((resolve, reject) => {
      const process = spawn(
        "docker",
        ["compose", "up", "-d", "--wait", "--wait-timeout", "60", "postgres"],
        { cwd: this.projectRoot, windowsHide: true },
      );
      const output = [];
      process.stdout.on("data", (chunk) => output.push(chunk.toString()));
      process.stderr.on("data", (chunk) => output.push(chunk.toString()));
      process.once("error", (error) => reject(new Error(
        `Docker could not start the local database: ${error.message}`,
      )));
      process.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(
          `Docker could not start the local database (exit ${code}).\n${output.join("").trim()}`,
        ));
      });
    });
  }
}

module.exports = { LocalInfrastructure };
