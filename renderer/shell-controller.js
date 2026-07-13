window.shellController = (() => {
  const drawer = document.querySelector("#left-drawer");
  const contextPanel = document.querySelector("#context-panel");
  const drawerToggle = document.querySelector("#drawer-toggle");
  const drawerTitle = document.querySelector("#drawer-title");
  const screenElements = {
    chat: document.querySelector("#chat-screen"),
    overview: document.querySelector("#overview-screen"),
    settings: document.querySelector("#settings-screen"),
  };
  const panelTitles = {
    sources: "Zdroje a importy",
    discord: "Vestavěný Discord",
    discordBot: "Discord bot",
    whatsapp: "WhatsApp export",
    importResult: "Výsledek importu",
  };
  let discordActive = false;

  function openDrawerPanel(panelName = "sources") {
    document.querySelectorAll(".drawer-panel").forEach((panel) => {
      panel.classList.toggle("active", panel.id === `${toKebabCase(panelName)}-drawer-panel`);
    });
    drawerTitle.textContent = panelTitles[panelName] || panelTitles.sources;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    drawerToggle.setAttribute("aria-expanded", "true");
  }

  function closeDrawer() {
    if (discordActive) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    drawerToggle.setAttribute("aria-expanded", "false");
  }

  function toggleDrawer() {
    if (drawer.classList.contains("open")) closeDrawer();
    else openDrawerPanel("sources");
  }

  function showScreen(screenName) {
    Object.entries(screenElements).forEach(([name, element]) => {
      element.classList.toggle("hidden", name !== screenName);
    });
    document.querySelector("#open-chat-button").classList.toggle("active", screenName === "chat");
    document.querySelector("#open-chat-button").toggleAttribute("aria-current", screenName === "chat");
    document.querySelector("#open-overview-button").classList.toggle("active", screenName === "overview");
    document.querySelector("#open-overview-button").toggleAttribute("aria-current", screenName === "overview");
    document.querySelector("#open-settings-button").classList.toggle("active", screenName === "settings");
    document.querySelector("#open-settings-button").toggleAttribute("aria-current", screenName === "settings");
  }

  function setDiscordActive(isActive) {
    discordActive = isActive;
    document.body.classList.toggle("discord-open", isActive);
    if (isActive) openDrawerPanel("discord");
  }

  function openContext() {
    if (window.matchMedia("(max-width: 1100px)").matches) {
      contextPanel.classList.add("open");
    }
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

  drawerToggle.addEventListener("click", toggleDrawer);
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
  });

  return {
    closeContext, closeDrawer, openContext, openDrawerPanel, setDiscordActive,
    showScreen, toggleContext,
  };
})();
