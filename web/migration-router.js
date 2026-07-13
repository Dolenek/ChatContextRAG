const { httpError, readJson, sendJson } = require("./http-utils");

class MigrationRouter {
  constructor(backend, monitor) {
    this.backend = backend;
    this.monitor = monitor;
  }

  async handle(request, response, pathname, identity) {
    if (!pathname.startsWith("/api/migrations")) return false;
    if (identity.kind !== "bearer") throw httpError("Desktop token required.", 403);
    if (request.method === "POST" && pathname === "/api/migrations") {
      return this.respond(response, this.create(request));
    }
    const match = pathname.match(/^\/api\/migrations\/([^/]+)(?:\/(messages|sync-states|complete|index))?$/);
    if (!match) return false;
    const migrationId = decodeIdentifier(match[1]);
    return this.handleMigration(request, response, migrationId, match[2]);
  }

  async handleMigration(request, response, migrationId, action) {
    if (request.method === "GET" && !action) {
      return this.respond(response, this.status(migrationId));
    }
    if (request.method === "POST" && action === "messages") {
      return this.respond(response, this.importMessages(request, migrationId));
    }
    if (request.method === "PUT" && action === "sync-states") {
      return this.respond(response, this.mergeSyncStates(request));
    }
    if (request.method === "POST" && action === "complete") {
      return this.respond(response, this.complete(migrationId));
    }
    if (request.method === "POST" && action === "index") {
      return this.respond(response, this.index(migrationId));
    }
    return false;
  }

  async create(request) {
    await readJson(request, 16 * 1024);
    return this.backend.post("/ingestion/sessions", {
      source_type: "migration",
      conversation_id: "desktop-archive",
      conversation_label: "Desktop archive migration",
    });
  }

  status(migrationId) {
    return this.backend.get(`/ingestion/sessions/${encodeURIComponent(migrationId)}`);
  }

  async importMessages(request, migrationId) {
    const input = await readJson(request, 2 * 1024 * 1024);
    if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 400) {
      throw httpError("Migration batches must contain between 1 and 400 messages.", 400);
    }
    const result = await this.backend.post("/messages/import", {
      session_id: migrationId, messages: input.messages,
    });
    return {
      accepted_count: input.messages.length,
      imported_count: result.imported_count,
      unique_content_count: result.unique_content_count,
    };
  }

  async mergeSyncStates(request) {
    const input = await readJson(request, 2 * 1024 * 1024);
    if (!Array.isArray(input.states) || input.states.length > 200) {
      throw httpError("A migration may merge at most 200 sync states per batch.", 400);
    }
    const existing = await this.backend.get("/integrations/sync-states?source_type=discord");
    const existingById = new Map(existing.map((state) => [state.conversation_id, state]));
    const saved = [];
    for (const source of input.states) {
      if (source.source_type !== "discord") {
        throw httpError("Only Discord sync states can be migrated.", 400);
      }
      const merged = mergeDiscordState(existingById.get(source.conversation_id), source);
      saved.push(await this.backend.post("/integrations/sync-state", merged));
    }
    return { states: saved };
  }

  complete(migrationId) {
    return this.backend.post(
      `/ingestion/sessions/${encodeURIComponent(migrationId)}/finish`,
      { reason: "completed", queue_indexing: false },
    );
  }

  async index(migrationId) {
    const session = await this.backend.post(
      `/ingestion/sessions/${encodeURIComponent(migrationId)}/index`, {},
    );
    this.monitor.startSessionJobs(session);
    return session;
  }

  async respond(response, promise) {
    sendJson(response, 200, await promise);
    return true;
  }
}

function mergeDiscordState(destination, source) {
  return {
    source_type: "discord",
    conversation_id: source.conversation_id,
    container_id: destination?.container_id || source.container_id || null,
    conversation_label: destination?.conversation_label || source.conversation_label || null,
    container_label: destination?.container_label || source.container_label || null,
    oldest_cursor: cursorBoundary(destination?.oldest_cursor, source.oldest_cursor, "min"),
    newest_cursor: cursorBoundary(destination?.newest_cursor, source.newest_cursor, "max"),
    active_session_id: null,
    backfill_complete: Boolean(destination?.backfill_complete || source.backfill_complete),
    tracking_enabled: destination
      ? Boolean(destination.tracking_enabled) : Boolean(source.tracking_enabled),
    last_error: null,
  };
}

function cursorBoundary(left, right, direction) {
  if (!left) return right || null;
  if (!right) return left;
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return left;
  const comparison = BigInt(left) < BigInt(right);
  if (direction === "min") return comparison ? left : right;
  return comparison ? right : left;
}

function decodeIdentifier(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw httpError("Migration identifier is invalid.", 400);
  }
}

module.exports = { MigrationRouter, cursorBoundary, mergeDiscordState };
