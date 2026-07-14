const { MigrationRetryPolicy } = require("../electron/migration-retry");

function message(externalId, content = `message ${externalId}`) {
  return { external_id: externalId, author: "Ada", content, source_type: "discord" };
}

function sourceClient(messages, deletes) {
  return {
    get: async (pathname) => getSourcePage(pathname, messages),
    delete: async (pathname) => {
      deletes.push(pathname);
      return { deleted: true };
    },
  };
}

function getSourcePage(pathname, messages) {
  if (pathname.startsWith("/database/overview")) {
    return { total_source_messages: messages.length };
  }
  if (pathname === "/internal/migration-exports/export-1") {
    return { export_id: "export-1", total_messages: messages.length };
  }
  const cursor = new URL(pathname, "http://local").searchParams.get("after_external_id");
  const page = messages.filter((item) => !cursor || item.external_id > cursor);
  return {
    export_id: "export-1",
    total_messages: messages.length,
    messages: page.slice(0, 400),
    next_cursor: page.at(399)?.external_id,
    done: page.length <= 400,
  };
}

function remoteClient(imported, calls, beforeImport) {
  return {
    get: async (pathname) => getRemoteState(pathname, imported),
    post: async (pathname, body) => postRemoteBatch(
      pathname, body, imported, calls, beforeImport,
    ),
    put: async (pathname, body) => {
      calls.push([pathname, body]);
      return body;
    },
  };
}

function getRemoteState(pathname, imported) {
  if (pathname === "/runtime") {
    return { migrationImport: true, migrationProtocolVersion: 1 };
  }
  if (pathname.startsWith("/database/overview")) return { total_source_messages: 2 };
  return { session_id: "migration-1", status: "running", raw_message_count: imported.size };
}

async function postRemoteBatch(pathname, body, imported, calls, beforeImport) {
  calls.push([pathname, body]);
  if (pathname === "/migrations") return { session_id: "migration-1", status: "running" };
  if (pathname.endsWith("/messages")) {
    await beforeImport();
    body.messages.forEach((item) => imported.add(item.external_id));
    return { accepted_count: body.messages.length };
  }
  if (pathname.endsWith("/index")) return { indexing_job_ids: ["job-1"] };
  return { status: "completed", raw_message_count: imported.size, indexing_job_ids: [] };
}

function resumableState(totalMessages, transferredMessages = 0, cursor = null) {
  return {
    phase: "paused",
    baseUrl: "http://server:8080",
    localExportId: "export-1",
    remoteMigrationId: "migration-1",
    totalMessages,
    transferredMessages,
    cursor,
    syncStates: [],
    error: null,
  };
}

function exportPage(messages, totalMessages, done) {
  return {
    export_id: "export-1",
    total_messages: totalMessages,
    messages,
    next_cursor: messages.at(-1)?.external_id,
    done,
  };
}

function backendTimeout(endpoint) {
  return Object.assign(new Error("Local API timed out after 30 seconds."), {
    code: "BACKEND_TIMEOUT",
    endpoint,
  });
}

function immediateRetryPolicy() {
  return new MigrationRetryPolicy({ delaysMs: [0, 0], wait: async () => {} });
}

function generatedSourceClient(totalMessages, onDelete) {
  return {
    get: async (pathname) => getGeneratedSourcePage(pathname, totalMessages),
    delete: async () => {
      onDelete();
      return { deleted: true };
    },
  };
}

function getGeneratedSourcePage(pathname, totalMessages) {
  if (pathname === "/internal/migration-exports/export-1") {
    return { export_id: "export-1", total_messages: totalMessages };
  }
  const cursor = new URL(pathname, "http://local").searchParams.get("after_external_id");
  const start = cursor ? Number(cursor) + 1 : 1;
  const end = Math.min(totalMessages, start + 399);
  const messages = Array.from(
    { length: Math.max(0, end - start + 1) },
    (_, offset) => message(String(start + offset).padStart(6, "0")),
  );
  return exportPage(messages, totalMessages, end >= totalMessages);
}

function memoryStore(initial = null) {
  let state = initial ? structuredClone(initial) : null;
  return {
    load: () => state ? structuredClone(state) : null,
    save: (value) => {
      state = structuredClone(value);
      return value;
    },
    clear: () => { state = null; },
  };
}

function rememberedConnectionStore() {
  let remembered = null;
  return {
    rememberRemote: (input) => {
      remembered = { baseUrl: input.baseUrl, token: input.token };
    },
    resolveRemote: (input) => resolveRememberedRemote(input, remembered),
  };
}

function resolveRememberedRemote(input, remembered) {
  if (input.token) return { baseUrl: input.baseUrl, token: input.token };
  if (!remembered || remembered.baseUrl !== input.baseUrl) {
    throw new Error("Remote token is unavailable for this server.");
  }
  return remembered;
}

module.exports = {
  backendTimeout,
  exportPage,
  generatedSourceClient,
  immediateRetryPolicy,
  memoryStore,
  message,
  rememberedConnectionStore,
  remoteClient,
  resumableState,
  sourceClient,
};
