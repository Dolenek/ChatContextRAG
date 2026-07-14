const { readJson, sendJson } = require("./http-utils");

class SettingsRouter {
  constructor(coordinator) {
    this.coordinator = coordinator;
  }

  async handle(request, response, pathname) {
    const method = request.method;
    if (method === "GET" && pathname === "/api/settings") {
      return this.respond(response, this.coordinator.getSettings());
    }
    if (method === "GET" && pathname === "/api/settings/workspace") {
      return this.respond(response, this.coordinator.getWorkspaceSettings());
    }
    if (method === "PUT" && pathname === "/api/settings/workspace") {
      const input = await readJson(request);
      return this.respond(
        response, this.coordinator.updateWorkspaceSettings(input.timezoneName),
      );
    }
    if (method === "POST" && pathname === "/api/settings/providers") {
      return this.respond(response, this.saveProvider(request));
    }
    if (method === "DELETE" && pathname.startsWith("/api/settings/providers/")) {
      const id = decodeURIComponent(pathname.slice("/api/settings/providers/".length));
      return this.respond(response, this.coordinator.deleteProvider(id));
    }
    const modelMatch = pathname.match(/^\/api\/settings\/providers\/([^/]+)\/models$/);
    if (method === "GET" && modelMatch) {
      return this.respond(response, this.coordinator.listProviderModels(
        decodeURIComponent(modelMatch[1]),
      ));
    }
    if (method === "PUT" && pathname === "/api/settings/chat-default") {
      return this.respond(response, this.saveChatDefault(request));
    }
    if (method === "POST" && pathname === "/api/settings/chat-models") {
      return this.respond(response, this.saveChatModel(request));
    }
    if (method === "DELETE" && pathname === "/api/settings/chat-models") {
      return this.respond(response, this.deleteChatModel(request));
    }
    return this.handleIndexes(request, response, pathname);
  }

  async handleIndexes(request, response, pathname) {
    if (request.method === "POST" && pathname === "/api/settings/embedding-indexes") {
      return this.respond(response, this.createIndex(request));
    }
    if (request.method === "PUT" && pathname === "/api/settings/active-embedding-index") {
      return this.respond(response, this.activateIndex(request));
    }
    const match = pathname.match(
      /^\/api\/settings\/embedding-indexes\/([^/]+)(?:\/(sync|rebuild))?$/,
    );
    if (!match) return false;
    const indexId = decodeURIComponent(match[1]);
    const action = match[2];
    if (request.method === "PATCH" && !action) {
      return this.respond(response, this.updateIndex(request, indexId));
    }
    if (request.method === "DELETE" && !action) {
      return this.respond(response, this.coordinator.deleteIndex(indexId));
    }
    if (request.method === "POST" && action === "sync") {
      return this.respond(response, this.coordinator.syncIndex(indexId));
    }
    if (request.method === "POST" && action === "rebuild") {
      return this.respond(response, this.coordinator.rebuildIndex(indexId));
    }
    return false;
  }

  async saveProvider(request) {
    return this.coordinator.saveProvider(await readJson(request));
  }

  async saveChatDefault(request) {
    const input = await readJson(request);
    return this.coordinator.saveChatDefault(input.providerId, input.model);
  }

  async saveChatModel(request) {
    return this.coordinator.saveChatModel(await readJson(request));
  }

  async deleteChatModel(request) {
    const input = await readJson(request);
    return this.coordinator.deleteChatModel(input.providerId, input.model);
  }

  async createIndex(request) {
    return this.coordinator.createIndex(await readJson(request));
  }

  async activateIndex(request) {
    const input = await readJson(request);
    return this.coordinator.activateIndex(input.indexId);
  }

  async updateIndex(request, indexId) {
    return this.coordinator.updateIndex(indexId, await readJson(request));
  }

  async respond(response, promise) {
    sendJson(response, 200, await promise);
    return true;
  }
}

module.exports = { SettingsRouter };
