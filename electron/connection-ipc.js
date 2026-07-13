const { ipcMain } = require("electron");
const { BackendClient } = require("../runtime/backend-client");
const { normalizeServerUrl } = require("./connection-store");

class ConnectionIpcController {
  constructor(options) {
    this.store = options.store;
    this.restart = options.restart;
  }

  register() {
    ipcMain.handle("connection:get", () => this.store.getPublic());
    ipcMain.handle("connection:test", (_event, input) => this.test(input));
    ipcMain.handle("connection:save", async (_event, input) => {
      if (input.mode === "remote") await this.test(input);
      const saved = this.store.save(input);
      this.restart();
      return saved;
    });
  }

  async test(input) {
    if (input.mode === "local") return { mode: "local", reachable: true };
    const baseUrl = normalizeServerUrl(input.baseUrl);
    const token = input.token?.trim() || this.savedRemoteToken();
    if (!token) throw new Error("Remote workspace token is required.");
    const client = new BackendClient(`${baseUrl}/api`, {
      Authorization: `Bearer ${token}`,
    });
    const capabilities = await client.get("/runtime");
    return { mode: "remote", reachable: true, capabilities };
  }

  savedRemoteToken() {
    try {
      const active = this.store.getActive();
      return active.mode === "remote" ? active.token : null;
    } catch {
      return null;
    }
  }
}

module.exports = { ConnectionIpcController };
