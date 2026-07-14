(() => {
  if (window.chatContext) return;

  let sessionPromise = null;
  let selectedWhatsAppFile = null;
  let eventSource = null;
  const subscribers = { indexing: new Set(), "discord-bot": new Set() };

  async function ensureSession() {
    if (!sessionPromise) {
      sessionPromise = fetch("/api/auth/session").then(readResponse).catch((error) => {
        sessionPromise = null;
        if (error.status === 401) window.location.replace("/login");
        throw error;
      });
    }
    return sessionPromise;
  }

  async function api(path, options = {}) {
    const session = await ensureSession();
    const method = options.method || "GET";
    const headers = { ...(options.headers || {}) };
    if (!["GET", "HEAD"].includes(method)) headers["X-CSRF-Token"] = session.csrf_token;
    const request = { method, headers };
    if (options.body instanceof FormData) request.body = options.body;
    else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      request.body = JSON.stringify(options.body);
    }
    try {
      return await readResponse(await fetch(`/api${path}`, request));
    } catch (error) {
      if (error.status === 401) window.location.replace("/login");
      throw error;
    }
  }

  async function readResponse(response) {
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; }
    catch { payload = { detail: text }; }
    if (!response.ok) {
      throw Object.assign(new Error(payload.detail || `Server vrátil ${response.status}.`), {
        status: response.status,
      });
    }
    return payload;
  }

  function subscribe(type, callback) {
    subscribers[type].add(callback);
    startEvents();
    return () => subscribers[type].delete(callback);
  }

  function startEvents() {
    if (eventSource) return;
    eventSource = new EventSource("/api/events");
    eventSource.onmessage = (event) => {
      const message = JSON.parse(event.data);
      subscribers[message.type]?.forEach((callback) => callback(message.payload));
    };
  }

  function selectWhatsAppExport() {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      let settled = false;
      const finish = (file) => {
        if (settled) return;
        settled = true;
        selectedWhatsAppFile = file;
        resolve(file ? { fileName: file.name } : null);
      };
      input.type = "file";
      input.accept = ".txt,.zip,text/plain,application/zip";
      input.addEventListener("change", () => finish(input.files?.[0] || null), { once: true });
      window.addEventListener("focus", () => {
        window.setTimeout(() => finish(input.files?.[0] || null), 300);
      }, { once: true });
      input.click();
    });
  }

  async function sendWhatsApp(path, options = {}) {
    if (!selectedWhatsAppFile) throw new Error("Nejdřív vyberte WhatsApp export.");
    const form = new FormData();
    form.append("export_file", selectedWhatsAppFile, selectedWhatsAppFile.name);
    Object.entries(options).forEach(([key, value]) => {
      if (value !== null && value !== undefined && value !== "") form.append(key, String(value));
    });
    return api(path, { method: "POST", body: form });
  }

  function openDiscordSource(source) {
    const url = `https://discord.com/channels/${source.guild_id}/${source.channel_id}/${source.message_id}`;
    window.open(url, "_blank", "noopener,noreferrer");
    return Promise.resolve({ embedded: false });
  }

  async function inviteDiscordBot() {
    const result = await api("/discord-bot/invite");
    window.open(result.invite_url, "_blank", "noopener,noreferrer");
    return { opened: true };
  }

  window.chatContext = {
    getRuntimeCapabilities: () => api("/runtime"),
    getConnectionTarget: () => Promise.resolve({ mode: "web", hasToken: false }),
    testConnectionTarget: () => Promise.reject(new Error("Webový server nemění svůj vlastní cíl.")),
    saveConnectionTarget: () => Promise.reject(new Error("Webový server nemění svůj vlastní cíl.")),
    inspectArchiveMigration: () => Promise.reject(new Error("Migraci lze spustit jen z Electronu.")),
    startArchiveMigration: () => Promise.reject(new Error("Migraci lze spustit jen z Electronu.")),
    pauseArchiveMigration: () => Promise.reject(new Error("Migraci lze spustit jen z Electronu.")),
    resumeArchiveMigration: () => Promise.reject(new Error("Migraci lze spustit jen z Electronu.")),
    getArchiveMigrationStatus: () => Promise.resolve({ available: false, phase: "unavailable" }),
    indexArchiveMigration: () => Promise.reject(new Error("Migraci lze spustit jen z Electronu.")),
    forgetArchiveMigration: () => Promise.resolve({ available: false, phase: "unavailable" }),
    onArchiveMigrationProgress: () => () => {},
    openDiscord: () => Promise.reject(new Error("Vestavěný Discord je dostupný jen v Electronu.")),
    openDiscordSource,
    captureDiscord: () => Promise.reject(new Error("Vestavěný Discord je dostupný jen v Electronu.")),
    startDiscordScan: () => Promise.reject(new Error("Vestavěný Discord je dostupný jen v Electronu.")),
    resumeDiscordScan: () => Promise.reject(new Error("Vestavěný Discord je dostupný jen v Electronu.")),
    stopDiscordScan: () => Promise.resolve({ stopping: false }),
    onDiscordScanProgress: () => () => {},
    onIndexingProgress: (callback) => subscribe("indexing", callback),
    hideDiscord: () => Promise.resolve(),
    askDatabase: (question, history, scope, selection = {}, sessionId = null) => api("/chat", {
      method: "POST",
      body: {
        question, history, scope,
        chat_provider_id: selection.providerId,
        chat_model: selection.model,
        ...(selection.reasoningEffort
          ? { reasoning_effort: selection.reasoningEffort } : {}),
        ...(sessionId ? { session_id: sessionId } : {}),
      },
    }),
    getChatScopes: () => api("/chat/scopes"),
    listChatSessions: (limit = 10) => api(`/chat/sessions?limit=${limit}`),
    getChatSession: (id) => api(`/chat/sessions/${encodeURIComponent(id)}`),
    renameChatSession: (id, title) => api(`/chat/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH", body: { title },
    }),
    deleteChatSession: (id) => api(`/chat/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE", body: {},
    }),
    getDatabaseOverview: (limit, offset) => api(`/database/overview?limit=${limit}&offset=${offset}`),
    clearDatabase: (confirmation) => api("/database", { method: "DELETE", body: { confirmation } }),
    retryIndexingJob: (id) => api(`/indexing/jobs/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} }),
    cancelIndexingJob: (id) => api(`/indexing/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: {} }),
    getIndexingJob: (id) => api(`/indexing/jobs/${encodeURIComponent(id)}`),
    indexPendingMessages: () => api("/indexing/jobs/pending", { method: "POST", body: {} }),
    getDiscordBotStatus: () => api("/discord-bot/status"),
    connectDiscordBot: (token) => api("/discord-bot/connect", { method: "POST", body: { token } }),
    disconnectDiscordBot: () => api("/discord-bot/disconnect", { method: "POST", body: {} }),
    inviteDiscordBot,
    onDiscordBotProgress: (callback) => subscribe("discord-bot", callback),
    selectWhatsAppExport,
    previewWhatsAppExport: (options) => sendWhatsApp("/imports/whatsapp/preview", options),
    importWhatsAppExport: (options) => sendWhatsApp("/imports/whatsapp", options),
    getWhatsAppConversations: () => api("/whatsapp/conversations"),
    getSettings: () => api("/settings"),
    saveProvider: (profile) => api("/settings/providers", { method: "POST", body: profile }),
    deleteProvider: (id) => api(`/settings/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
    listProviderModels: (id) => api(`/settings/providers/${encodeURIComponent(id)}/models`),
    saveChatDefault: (providerId, model) => api("/settings/chat-default", { method: "PUT", body: { providerId, model } }),
    saveChatModel: (model) => api("/settings/chat-models", { method: "POST", body: model }),
    deleteChatModel: (providerId, model) => api("/settings/chat-models", { method: "DELETE", body: { providerId, model } }),
    createEmbeddingIndex: (input) => api("/settings/embedding-indexes", { method: "POST", body: input }),
    updateEmbeddingIndex: (id, update) => api(`/settings/embedding-indexes/${encodeURIComponent(id)}`, { method: "PATCH", body: update }),
    activateEmbeddingIndex: (id) => api("/settings/active-embedding-index", { method: "PUT", body: { indexId: id } }),
    syncEmbeddingIndex: (id) => api(`/settings/embedding-indexes/${encodeURIComponent(id)}/sync`, { method: "POST", body: {} }),
    rebuildEmbeddingIndex: (id) => api(`/settings/embedding-indexes/${encodeURIComponent(id)}/rebuild`, { method: "POST", body: {} }),
    deleteEmbeddingIndex: (id) => api(`/settings/embedding-indexes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  };

  document.body.classList.add("web-runtime");
  const logoutButton = document.querySelector("#settings-logout-button");
  logoutButton?.classList.remove("hidden");
  logoutButton?.addEventListener("click", async () => {
    await api("/auth/logout", { method: "POST", body: {} });
    window.location.replace("/login");
  });
  const providerDescription = document.querySelector("#provider-list")
    ?.closest(".settings-card")?.querySelector("p");
  if (providerDescription) {
    providerDescription.textContent =
      "API klíče pro chat i embedding/indexing jsou šifrované v úložišti serveru.";
  }
})();
