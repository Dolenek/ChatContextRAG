(function exposeRuntimeCapabilitiesUi() {
  const desktopModes = new Set(["electron-local", "electron-remote"]);

  function setRuntimeAvailability(selector, isAvailable) {
    const element = document.querySelector(selector);
    if (!element) return;
    element.classList.toggle("hidden", !isAvailable);
    if (isAvailable) element.removeAttribute("aria-hidden");
    else element.setAttribute("aria-hidden", "true");
  }

  function apply(capabilities = {}) {
    const isDesktop = desktopModes.has(capabilities.mode);
    const hasLocalDiscordScanner = isDesktop && capabilities.embeddedDiscord === true;
    document.body.dataset.runtimeMode = capabilities.mode || "unknown";
    setRuntimeAvailability("#connection-settings-card", isDesktop);
    setRuntimeAvailability("#open-discord-button", hasLocalDiscordScanner);
    setRuntimeAvailability("#discord-drawer-panel", hasLocalDiscordScanner);
    return capabilities;
  }

  async function refresh() {
    return apply(await window.chatContext.getRuntimeCapabilities());
  }

  window.runtimeCapabilitiesUi = { apply, refresh };
}());
