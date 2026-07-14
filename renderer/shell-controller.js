window.shellController = (() => {
  const NAVIGATION_STORAGE_KEY = "chat-context.navigation-mode";
  const EXPANDED_MODE = "expanded";
  const COLLAPSED_MODE = "collapsed";
  const drawer = document.querySelector("#left-drawer");
  const contextPanel = document.querySelector("#context-panel");
  const navigationToggle = document.querySelector("#navigation-toggle");
  const navigationToggleLabel = document.querySelector("#navigation-toggle-label");
  const sourcesButton = document.querySelector("#open-sources-button");
  const drawerTitle = document.querySelector("#drawer-title");
  const screenElements = {
    chat: document.querySelector("#chat-screen"),
    overview: document.querySelector("#overview-screen"),
  };
  const panelTitles = {
    sources: "Zdroje a importy",
    discord: "Vestavěný Discord",
    discordBot: "Discord bot",
    whatsapp: "WhatsApp export",
    importResult: "Výsledek importu",
  };
  let preferredNavigationMode = readStoredNavigationMode();
  let responsiveNavigationOpen = false;
  let discordActive = false;
  let activeChatSessionId = null;

  function readStoredNavigationMode() {
    try {
      const storedMode = window.localStorage?.getItem(NAVIGATION_STORAGE_KEY);
      return [EXPANDED_MODE, COLLAPSED_MODE].includes(storedMode)
        ? storedMode : EXPANDED_MODE;
    } catch {
      return EXPANDED_MODE;
    }
  }

  function saveNavigationMode() {
    try {
      window.localStorage?.setItem(NAVIGATION_STORAGE_KEY, preferredNavigationMode);
    } catch {
      // Navigation remains usable when browser storage is unavailable.
    }
  }

  function isNarrowViewport() {
    return window.matchMedia("(max-width: 700px)").matches;
  }

  function isNavigationExpanded() {
    if (discordActive) return false;
    if (isNarrowViewport()) return responsiveNavigationOpen;
    return preferredNavigationMode === EXPANDED_MODE;
  }

  function applyNavigationState() {
    const isExpanded = isNavigationExpanded();
    const accessibleLabel = isExpanded ? "Sbalit navigaci" : "Rozbalit navigaci";
    document.body.classList.toggle("navigation-expanded", isExpanded);
    document.body.dataset.navigationMode = isExpanded ? EXPANDED_MODE : COLLAPSED_MODE;
    navigationToggle.setAttribute("aria-expanded", String(isExpanded));
    navigationToggle.setAttribute("aria-label", accessibleLabel);
    navigationToggleLabel.textContent = accessibleLabel;
    navigationToggle.disabled = discordActive;
  }

  function toggleNavigation() {
    if (discordActive) return;
    if (isNarrowViewport()) {
      responsiveNavigationOpen = !responsiveNavigationOpen;
    } else {
      preferredNavigationMode = preferredNavigationMode === EXPANDED_MODE
        ? COLLAPSED_MODE : EXPANDED_MODE;
      saveNavigationMode();
    }
    applyNavigationState();
  }

  function closeResponsiveNavigation() {
    if (!isNarrowViewport() || !responsiveNavigationOpen) return;
    responsiveNavigationOpen = false;
    applyNavigationState();
  }

  function handleViewportChange() {
    responsiveNavigationOpen = false;
    applyNavigationState();
  }

  function openDrawerPanel(panelName = "sources") {
    closeResponsiveNavigation();
    document.querySelectorAll(".drawer-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `${toKebabCase(panelName)}-drawer-panel`);
    });
    drawerTitle.textContent = panelTitles[panelName] || panelTitles.sources;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    sourcesButton.classList.add("drawer-active");
    sourcesButton.setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    if (discordActive) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    sourcesButton.classList.remove("drawer-active");
    sourcesButton.setAttribute("aria-expanded", "false");
  }

  function showScreen(screenName) {
    closeResponsiveNavigation();
    Object.entries(screenElements).forEach(([name, element]) => {
      element.classList.toggle("hidden", name !== screenName);
    });
    updateScreenButton(
      "#new-chat-button", screenName === "chat" && !activeChatSessionId,
    );
    updateScreenButton("#open-overview-button", screenName === "overview");
    window.chatHistoryUi?.setScreenActive?.(screenName === "chat");
  }

  function setActiveChatSession(sessionId) {
    activeChatSessionId = sessionId;
    const chatVisible = !screenElements.chat.classList.contains("hidden");
    updateScreenButton("#new-chat-button", chatVisible && !sessionId);
  }

  function updateScreenButton(selector, isActive) {
    const button = document.querySelector(selector);
    if (!button) return;
    button.classList.toggle("active", isActive);
    button.toggleAttribute("aria-current", isActive);
  }

  function setDiscordActive(isActive) {
    discordActive = isActive;
    responsiveNavigationOpen = false;
    document.body.classList.toggle("discord-open", isActive);
    applyNavigationState();
    if (isActive) openDrawerPanel("discord");
  }

  function openContext() {
    if (window.matchMedia("(max-width: 1100px)").matches) contextPanel.classList.add("open");
  }

  function closeContext() {
    contextPanel.classList.remove("open");
  }

  function toggleContext() {
    contextPanel.classList.toggle("open");
  }

  function toKebabCase(value) {
    return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
  }

  applyNavigationState();
  navigationToggle.addEventListener("click", toggleNavigation);
  document.querySelector("#drawer-close").addEventListener("click", closeDrawer);
  document.querySelector("#context-toggle").addEventListener("click", toggleContext);
  document.querySelector("#context-close").addEventListener("click", closeContext);
  document.querySelectorAll("[data-drawer-target]").forEach((button) => {
    button.addEventListener("click", () => openDrawerPanel(button.dataset.drawerTarget));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeContext();
    closeDrawer();
    closeResponsiveNavigation();
  });
  window.addEventListener?.("resize", handleViewportChange);

  return {
    closeContext, closeDrawer, closeResponsiveNavigation, openContext, openDrawerPanel,
    setActiveChatSession, setDiscordActive, showScreen, toggleContext, toggleNavigation,
  };
})();
