const { ipcMain } = require("electron");

class RemoteSettingsIpcController {
  constructor(client, monitorJob) {
    this.client = client;
    this.monitorJob = monitorJob;
  }

  register() {
    ipcMain.handle("settings:get", () => this.client.get("/settings"));
    ipcMain.handle("settings:provider:save", (_event, profile) =>
      this.client.post("/settings/providers", profile));
    ipcMain.handle("settings:provider:delete", (_event, id) =>
      this.client.delete(`/settings/providers/${encodeURIComponent(id)}`));
    ipcMain.handle("settings:models", (_event, id) =>
      this.client.get(`/settings/providers/${encodeURIComponent(id)}/models`));
    ipcMain.handle("settings:chat-default", (_event, input) =>
      this.client.put("/settings/chat-default", input));
    ipcMain.handle("settings:chat-model:save", (_event, model) =>
      this.client.post("/settings/chat-models", model));
    ipcMain.handle("settings:chat-model:delete", (_event, model) =>
      this.client.delete("/settings/chat-models", model));
    this.registerIndexHandlers();
  }

  registerIndexHandlers() {
    ipcMain.handle("settings:index:create", async (_event, input) => {
      const index = await this.client.post("/settings/embedding-indexes", input);
      this.monitorJob(index.active_job_id);
      return index;
    });
    ipcMain.handle("settings:index:update", (_event, input) => this.client.patch(
      `/settings/embedding-indexes/${input.indexId}`, input.update,
    ));
    ipcMain.handle("settings:index:activate", (_event, indexId) => this.client.put(
      "/settings/active-embedding-index", { indexId },
    ));
    ipcMain.handle("settings:index:sync", (_event, id) => this.monitorResponse(
      this.client.post(`/settings/embedding-indexes/${id}/sync`, {}), "job_id",
    ));
    ipcMain.handle("settings:index:rebuild", (_event, id) => this.monitorResponse(
      this.client.post(`/settings/embedding-indexes/${id}/rebuild`, {}), "active_job_id",
    ));
    ipcMain.handle("settings:index:delete", (_event, id) =>
      this.client.delete(`/settings/embedding-indexes/${id}`));
  }

  async monitorResponse(promise, jobProperty) {
    const response = await promise;
    this.monitorJob(response[jobProperty]);
    return response;
  }
}

module.exports = { RemoteSettingsIpcController };
