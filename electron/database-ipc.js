class DatabaseIpcController {
  constructor(options) {
    this.ipcMain = options.ipcMain;
    this.postJson = options.postJson;
    this.getJson = options.getJson;
    this.patchJson = options.patchJson;
    this.deleteJson = options.deleteJson;
    this.monitorIndexingJob = options.monitorIndexingJob;
  }

  register() {
    this.registerChatHandlers();
    this.registerDatabaseHandlers();
    this.registerIndexingHandlers();
  }

  registerChatHandlers() {
    this.ipcMain.handle("database:ask", (_event, request) => this.postJson(
      "/chat", request, chatRequestOptions(request),
    ));
    this.ipcMain.handle("database:chat-scopes", () => this.getJson("/chat/scopes"));
    this.ipcMain.handle("chat-sessions:list", (_event, limit) =>
      this.getJson(`/chat/sessions?limit=${encodeURIComponent(limit)}`));
    this.ipcMain.handle("chat-sessions:get", (_event, sessionId) =>
      this.getJson(`/chat/sessions/${encodeURIComponent(sessionId)}`));
    this.ipcMain.handle("chat-sessions:rename", (_event, input) => this.patchJson(
      `/chat/sessions/${encodeURIComponent(input.sessionId)}`, { title: input.title },
    ));
    this.ipcMain.handle("chat-sessions:delete", (_event, sessionId) =>
      this.deleteJson(`/chat/sessions/${encodeURIComponent(sessionId)}`));
  }

  registerDatabaseHandlers() {
    this.ipcMain.handle("database:overview", (_event, pagination) => {
      const parameters = new URLSearchParams(pagination);
      return this.getJson(`/database/overview?${parameters}`);
    });
    this.ipcMain.handle("database:status", (_event, options = {}) =>
      this.getJson(`/database/status${options.fresh ? "?fresh=true" : ""}`));
    this.ipcMain.handle("database:read-model-refresh", (_event, scope = "active") =>
      this.postJson("/database/read-model/refresh", { scope }));
    this.ipcMain.handle("database:breakdowns", () => this.getJson("/database/breakdowns"));
    this.ipcMain.handle("database:breakdown-page", (_event, pagination) => {
      const dimension = encodeURIComponent(pagination.dimension);
      const parameters = new URLSearchParams({
        limit: pagination.limit, offset: pagination.offset,
      });
      return this.getJson(`/database/breakdowns/${dimension}?${parameters}`);
    });
    this.ipcMain.handle("database:chunks", (_event, pagination) => {
      const parameters = new URLSearchParams({ limit: pagination.limit });
      if (pagination.cursor) parameters.set("cursor", pagination.cursor);
      return this.getJson(`/database/chunks?${parameters}`);
    });
    this.ipcMain.handle("database:clear", (_event, request) =>
      this.deleteJson("/database", request));
  }

  registerIndexingHandlers() {
    this.ipcMain.handle("indexing:retry", (_event, jobId) =>
      this.postJson(`/indexing/jobs/${jobId}/retry`, {}));
    this.ipcMain.handle("indexing:cancel", (_event, jobId) =>
      this.postJson(`/indexing/jobs/${jobId}/cancel`, {}));
    this.ipcMain.handle("indexing:get", (_event, jobId) =>
      this.getJson(`/indexing/jobs/${jobId}`));
    this.ipcMain.handle("indexing:active", () =>
      this.getJson("/indexing/jobs?status=active"));
    this.ipcMain.handle("indexing:pending", async () => {
      const job = await this.postJson("/indexing/jobs/pending", {});
      this.monitorIndexingJob(job.job_id);
      return job;
    });
  }
}

function chatRequestOptions(request) {
  return request.retrieval_mode === "adaptive" ? { timeoutMs: 130_000 } : {};
}

module.exports = { DatabaseIpcController, chatRequestOptions };
