window.contextDetailModal = (() => {
  const overlay = document.querySelector("#context-detail-overlay");
  const dialog = document.querySelector("#context-detail-dialog");
  const list = document.querySelector("#context-detail-list");
  const appLayout = document.querySelector(".app-layout");
  const focusableSelector = "button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";
  let sources = [];
  let focusReturnTarget = null;
  let previousInert = false;

  function setSources(nextSources) {
    sources = [...nextSources];
    document.querySelector("#context-detail-count").textContent = String(sources.length);
    if (isOpen()) render();
  }

  function open() {
    if (!sources.length || isOpen()) return;
    focusReturnTarget = document.activeElement;
    previousInert = appLayout.inert;
    appLayout.inert = true;
    render();
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    dialog.focus();
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    appLayout.inert = previousInert;
    focusReturnTarget?.focus?.();
    focusReturnTarget = null;
  }

  function render() {
    const cards = sources.map((source, index) =>
      window.chatSources.createChatSourceCard(source, { index: index + 1, mode: "detail" }));
    list.replaceChildren(...cards);
  }

  function handleKeydown(event) {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      keepFocusInside(event);
    }
  }

  function keepFocusInside(event) {
    const focusable = [...dialog.querySelectorAll(focusableSelector)];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) moveFocus(event, last);
    else if (!event.shiftKey && document.activeElement === last) moveFocus(event, first);
    else if (!dialog.contains(document.activeElement)) moveFocus(event, first);
  }

  function moveFocus(event, target) {
    event.preventDefault();
    target.focus();
  }

  function isOpen() {
    return !overlay.classList.contains("hidden");
  }

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.querySelector("#open-context-detail").addEventListener("click", open);
  document.querySelector("#close-context-detail").addEventListener("click", close);
  document.addEventListener("keydown", handleKeydown);
  return { close, isOpen, open, setSources };
})();
