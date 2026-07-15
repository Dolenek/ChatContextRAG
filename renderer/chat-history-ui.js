window.chatHistoryUi = (() => {
  const list = document.querySelector("#recent-chat-list");
  const renameDialog = document.querySelector("#rename-chat-dialog");
  const deleteDialog = document.querySelector("#delete-chat-dialog");
  const renameInput = document.querySelector("#rename-chat-input");
  const showMoreButton = document.querySelector("#show-more-chats-button");
  const collapsedCount = 6;
  let summaries = [];
  let expanded = false;
  let activeSessionId = null;
  let chatScreenActive = true;
  let pendingSession = null;
  let openMenu = null;
  let dependencies = {};

  function bind(inputDependencies) {
    dependencies = inputDependencies;
    document.querySelector("#rename-chat-form").addEventListener("submit", renameSession);
    document.querySelector("#cancel-rename-chat").addEventListener("click", closeDialogs);
    document.querySelector("#confirm-delete-chat").addEventListener("click", deleteSession);
    document.querySelector("#cancel-delete-chat").addEventListener("click", closeDialogs);
    showMoreButton.addEventListener("click", toggleExpanded);
    document.addEventListener("click", closeContextMenu);
    document.addEventListener("keydown", handleEscape);
  }

  async function refresh(force = false) {
    const cached = window.workspaceCache.peek("chat-sessions");
    if (cached) {
      summaries = cached;
      render();
    }
    const request = loadLatestSessions(force);
    if (cached && !force) {
      void request.catch((error) => dependencies.showToast?.(error.message, true));
      return;
    }
    try { await request; }
    catch (error) {
      dependencies.showToast?.(error.message, true);
    }
  }

  function loadLatestSessions(force) {
    return window.interactionCoordinator.runLatest(
      "chat-history-refresh",
      () => window.workspaceCache.load(
        "chat-sessions", () => window.chatContext.listChatSessions(20), 60000, force,
      ),
      (sessions) => { summaries = sessions; render(); },
    );
  }

  function render() {
    if (!summaries.length) {
      const empty = document.createElement("p");
      empty.className = "recent-chat-empty";
      empty.textContent = "Uložené chaty se objeví po první odpovědi.";
      list.replaceChildren(empty);
      showMoreButton.classList.add("hidden");
      return;
    }
    const visibleSummaries = expanded ? summaries : summaries.slice(0, collapsedCount);
    list.replaceChildren(...visibleSummaries.map(createRow));
    showMoreButton.classList.toggle("hidden", summaries.length <= collapsedCount);
    showMoreButton.firstChild.textContent = expanded ? "Zobrazit méně " : "Zobrazit další ";
  }

  function createRow(summary) {
    const row = document.createElement("div");
    const openButton = document.createElement("button");
    const timestamp = document.createElement("time");
    const menuButton = document.createElement("button");
    row.className = "recent-chat-row";
    const isActive = chatScreenActive && summary.session_id === activeSessionId;
    row.classList.toggle("active", isActive);
    openButton.className = "recent-chat-open";
    openButton.type = "button";
    openButton.title = summary.title;
    openButton.textContent = summary.title;
    openButton.toggleAttribute("aria-current", isActive);
    openButton.addEventListener("click", () => dependencies.openSession(summary.session_id));
    timestamp.className = "recent-chat-time";
    timestamp.textContent = formatRecentTimestamp(summary.updated_at);
    menuButton.className = "recent-chat-menu-button";
    menuButton.type = "button";
    menuButton.textContent = "⋯";
    menuButton.setAttribute("aria-label", `Akce pro chat ${summary.title}`);
    menuButton.addEventListener("click", (event) => showContextMenu(event, summary));
    row.append(openButton, timestamp, menuButton);
    return row;
  }

  function toggleExpanded() {
    expanded = !expanded;
    render();
  }

  function formatRecentTimestamp(value) {
    const timestamp = new Date(value);
    const today = new Date();
    const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const startTimestamp = new Date(
      timestamp.getFullYear(), timestamp.getMonth(), timestamp.getDate(),
    );
    const dayDifference = Math.round((startToday - startTimestamp) / 86400000);
    if (dayDifference === 0) return timestamp.toLocaleTimeString("cs-CZ", {
      hour: "2-digit", minute: "2-digit",
    });
    if (dayDifference === 1) return "Včera";
    return timestamp.toLocaleDateString("cs-CZ", {
      day: "numeric", month: "numeric",
      year: timestamp.getFullYear() === today.getFullYear() ? undefined : "numeric",
    });
  }

  function showContextMenu(event, summary) {
    event.stopPropagation();
    closeContextMenu();
    const menu = document.createElement("div");
    menu.className = "recent-chat-menu";
    menu.append(
      createMenuButton("Přejmenovat", () => showRenameDialog(summary)),
      createMenuButton("Odstranit chat", () => showDeleteDialog(summary), true),
    );
    document.body.append(menu);
    positionMenu(menu, event.currentTarget.getBoundingClientRect());
    openMenu = menu;
  }

  function createMenuButton(label, listener, danger = false) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.classList.toggle("danger-option", danger);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      closeContextMenu();
      listener();
    });
    return button;
  }

  function positionMenu(menu, anchor) {
    const width = 142;
    menu.style.left = `${Math.max(8, Math.min(anchor.right - width, innerWidth - width - 8))}px`;
    menu.style.top = `${Math.min(anchor.bottom + 3, innerHeight - 90)}px`;
  }

  function showRenameDialog(summary) {
    pendingSession = summary;
    renameInput.value = summary.title;
    renameDialog.classList.remove("hidden");
    renameInput.focus();
    renameInput.select();
  }

  function showDeleteDialog(summary) {
    pendingSession = summary;
    document.querySelector("#delete-chat-name").textContent = summary.title;
    deleteDialog.classList.remove("hidden");
    document.querySelector("#confirm-delete-chat").focus();
  }

  async function renameSession(event) {
    event.preventDefault();
    const title = renameInput.value.trim();
    if (!title || !pendingSession) return;
    const session = pendingSession;
    try {
      await window.interactionCoordinator.runMutation({
        key: `rename-chat:${session.session_id}`,
        controls: [{ element: event.submitter, pendingText: "Ukládám…" }],
        apply: () => projectRename(session, title),
        execute: () => window.chatContext.renameChatSession(session.session_id, title),
        rollback: restoreRename,
        reconcile: () => refresh(true),
        reconcileFailed: showReconcileFailure,
      });
    } catch (error) {
      dependencies.showToast?.(error.message, true);
    }
  }

  async function deleteSession() {
    if (!pendingSession) return;
    const deletedId = pendingSession.session_id;
    try {
      await window.interactionCoordinator.runMutation({
        key: `delete-chat:${deletedId}`,
        controls: [{
          element: document.querySelector("#confirm-delete-chat"), pendingText: "Mažu…",
        }],
        execute: () => window.chatContext.deleteChatSession(deletedId),
        commit: () => commitDelete(deletedId),
        reconcile: () => refresh(true),
        reconcileFailed: showReconcileFailure,
      });
    } catch (error) {
      dependencies.showToast?.(error.message, true);
    }
  }

  function projectRename(session, title) {
    const snapshot = { summaries, session, draftTitle: renameInput.value };
    summaries = summaries.map((summary) => summary.session_id === session.session_id
      ? { ...summary, title } : summary);
    storeProjectedSummaries();
    closeDialogs();
    render();
    return snapshot;
  }

  function restoreRename(snapshot) {
    summaries = snapshot.summaries;
    storeProjectedSummaries();
    render();
    showRenameDialog(snapshot.session);
    renameInput.value = snapshot.draftTitle;
  }

  function commitDelete(deletedId) {
    summaries = summaries.filter((summary) => summary.session_id !== deletedId);
    storeProjectedSummaries();
    closeDialogs();
    render();
    if (deletedId === activeSessionId) dependencies.startNewChat();
  }

  function showReconcileFailure(error) {
    window.workspaceCache.invalidate("chat-sessions");
    dependencies.showToast?.(`Změna je uložená, obnovení selhalo: ${error.message}`, true);
  }

  function storeProjectedSummaries() {
    window.interactionCoordinator.supersede("chat-history-refresh");
    window.workspaceCache.store("chat-sessions", summaries);
  }

  function setActiveSession(sessionId) {
    activeSessionId = sessionId;
    window.shellController.setActiveChatSession(sessionId);
    render();
  }

  function setScreenActive(isActive) {
    chatScreenActive = isActive;
    render();
  }

  async function responseSaved(response) {
    setActiveSession(response.chat_session_id || null);
    window.workspaceCache.invalidate("chat-sessions");
    await refresh(true);
  }

  function closeDialogs() {
    renameDialog.classList.add("hidden");
    deleteDialog.classList.add("hidden");
    pendingSession = null;
  }

  function closeContextMenu() {
    openMenu?.remove();
    openMenu = null;
  }

  function handleEscape(event) {
    if (event.key !== "Escape") return;
    closeContextMenu();
    closeDialogs();
  }

  return { bind, refresh, responseSaved, setActiveSession, setScreenActive };
})();
