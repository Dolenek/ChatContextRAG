window.conversationView = (() => {
  const conversation = document.querySelector("#conversation");
  const textarea = document.querySelector("#question-input");

  function appendUser(text, createdAt = new Date(), persisted = false) {
    removeEmptyState();
    const entry = document.createElement("article");
    const message = document.createElement("div");
    const bubble = createBubble(text);
    const status = document.createElement("div");
    entry.className = "conversation-entry user";
    message.className = "user-message";
    status.className = "message-status";
    status.append(createTime(createdAt), createPersistedMark(persisted));
    message.append(bubble, status);
    entry.append(message);
    conversation.append(entry);
    scrollToLatest();
    return entry;
  }

  function appendAssistant(text, sources = [], toolActivity = []) {
    removeEmptyState();
    const entry = createAssistantEntry(text, sources, toolActivity);
    conversation.append(entry);
    scrollToLatest();
    return entry;
  }

  function createAssistantEntry(text, sources = [], toolActivity = []) {
    const entry = document.createElement("article");
    const card = document.createElement("div");
    entry.className = "conversation-entry assistant";
    card.className = "assistant-card";
    card.append(createBubble(text));
    if (toolActivity.length) card.append(window.toolActivityView.createSummary(toolActivity));
    if (sources.length) card.append(createSourceFooter(sources));
    entry.append(createAssistantAvatar(), card);
    return entry;
  }

  function appendThinking() {
    removeEmptyState();
    const entry = document.createElement("article");
    const card = document.createElement("div");
    const status = document.createElement("span");
    entry.className = "conversation-entry assistant thinking-entry";
    card.className = "assistant-card thinking-card";
    card.setAttribute("role", "status");
    card.setAttribute("aria-live", "polite");
    status.className = "sr-only";
    status.textContent = "Přemýšlím…";
    card.append(status, createThinkingDots(), window.toolActivityView.createLiveRegion());
    entry.append(createAssistantAvatar(), card);
    conversation.append(entry);
    scrollToLatest();
    return entry;
  }

  function createThinkingDots() {
    const dots = document.createElement("span");
    dots.className = "thinking-dots";
    dots.setAttribute("aria-hidden", "true");
    dots.append(...[0, 1, 2].map(() => document.createElement("i")));
    return dots;
  }

  function replaceThinking(entry, text, sources = [], toolActivity = []) {
    const answerEntry = createAssistantEntry(text, sources, toolActivity);
    entry?.replaceWith(answerEntry);
    scrollToLatest();
    return answerEntry;
  }

  function removeThinking(entry) {
    entry?.remove?.();
  }

  function updateThinking(entry, record) {
    window.toolActivityView.updateLive(entry, record);
    scrollToLatest();
  }

  function createBubble(text) {
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;
    return bubble;
  }

  function createTime(value) {
    const time = document.createElement("time");
    time.textContent = value ? new Date(value).toLocaleTimeString("cs-CZ", {
      hour: "2-digit", minute: "2-digit",
    }) : "";
    return time;
  }

  function createPersistedMark(persisted) {
    const mark = document.createElement("span");
    mark.className = "persisted-mark";
    mark.textContent = persisted ? "✓✓" : "";
    mark.setAttribute("aria-label", persisted ? "Uloženo" : "Čeká na uložení");
    return mark;
  }

  function markPersisted(entry) {
    const mark = entry?.querySelector?.(".persisted-mark");
    if (!mark) return;
    mark.textContent = "✓✓";
    mark.setAttribute("aria-label", "Uloženo");
  }

  function markFailed(entry) {
    const mark = entry?.querySelector?.(".persisted-mark");
    if (!mark) return;
    entry.classList.add("message-failed");
    mark.textContent = "!";
    mark.setAttribute("aria-label", "Nepodařilo se uložit");
  }

  function createAssistantAvatar() {
    const avatar = document.createElement("span");
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    avatar.className = "assistant-avatar";
    avatar.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#icon-sparkles");
    svg.append(use);
    avatar.append(svg);
    return avatar;
  }

  function createSourceFooter(sources) {
    const footer = document.createElement("div");
    const button = document.createElement("button");
    footer.className = "assistant-footer";
    button.className = "source-recall-button";
    button.type = "button";
    button.append(createIcon("#icon-shield"), document.createTextNode(
      `Odpověď podložena ${sources.length} zprávami`), createCaret());
    button.addEventListener("click", () => showSources(sources));
    footer.append(button);
    return footer;
  }

  function createIcon(href) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", href);
    svg.append(use);
    return svg;
  }

  function createCaret() {
    const caret = document.createElement("span");
    caret.className = "source-caret";
    caret.textContent = "⌃";
    caret.setAttribute("aria-hidden", "true");
    return caret;
  }

  function showSources(sources) {
    window.shellController.openContext();
    window.contextPanel.showSources(sources);
    window.contextPanel.flash();
  }

  function renderMessages(messages) {
    conversation.replaceChildren();
    messages.forEach((message) => {
      if (message.role === "user") appendUser(message.content, message.created_at, true);
      else appendAssistant(
        message.content, message.sources || [], message.tool_activity || [],
      );
    });
  }

  function reset(scopeLabel) {
    const empty = document.createElement("div");
    empty.className = "empty-chat";
    const icon = document.createElement("span");
    const heading = document.createElement("h2");
    const prompt = document.createElement("p");
    icon.textContent = "✦";
    heading.textContent = "Nový chat";
    prompt.textContent = `Položte první otázku nad ${scopeLabel.toLowerCase()}.`;
    empty.append(icon, heading, prompt);
    conversation.replaceChildren(empty);
  }

  function bindComposer() {
    textarea.addEventListener("input", resizeComposer);
    textarea.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      event.preventDefault();
      if (textarea.value.trim()) textarea.form.requestSubmit();
    });
  }

  function resizeComposer() {
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }

  function resetComposer() {
    textarea.value = "";
    textarea.style.height = "auto";
  }

  function removeEmptyState() { conversation.querySelector(".empty-chat")?.remove(); }
  function scrollToLatest() { conversation.scrollTop = conversation.scrollHeight; }

  return {
    appendAssistant, appendThinking, appendUser, bindComposer, markFailed,
    markPersisted, removeThinking, renderMessages, replaceThinking, reset, resetComposer,
    updateThinking,
  };
})();
