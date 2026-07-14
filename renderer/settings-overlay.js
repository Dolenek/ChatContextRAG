window.settingsOverlay = (() => {
  const defaultSection = "providers";
  const overlay = document.querySelector("#settings-overlay");
  const dialog = document.querySelector("#settings-dialog");
  const appLayout = document.querySelector(".app-layout");
  const settingsButton = document.querySelector("#open-settings-button");
  const closeButton = document.querySelector("#close-settings-button");
  const navigationButtons = [...document.querySelectorAll("[data-settings-section]")];
  const sectionPanels = [...document.querySelectorAll("[data-settings-panel]")];
  const focusableSelector = [
    "button:not([disabled])", "input:not([disabled])", "select:not([disabled])",
    "summary", "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  let closeCallback = () => {};
  let focusReturnTarget = null;
  let listenersBound = false;

  function bind(options = {}) {
    closeCallback = options.onClose || (() => {});
    if (listenersBound) return;
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", closeFromBackdrop);
    navigationButtons.forEach((button) => {
      button.addEventListener("click", () => selectSection(button.dataset.settingsSection));
    });
    document.addEventListener("keydown", handleKeydown);
    listenersBound = true;
  }

  function open(sectionName = defaultSection) {
    if (isOpen()) {
      selectSection(sectionName);
      return;
    }
    focusReturnTarget = document.activeElement;
    selectSection(sectionName);
    overlay.classList.remove("hidden");
    overlay.setAttribute("aria-hidden", "false");
    document.body.classList.add("settings-overlay-open");
    appLayout.inert = true;
    settingsButton.classList.add("active");
    settingsButton.setAttribute("aria-expanded", "true");
    closeButton.focus();
  }

  function close() {
    if (!isOpen()) return;
    overlay.classList.add("hidden");
    overlay.setAttribute("aria-hidden", "true");
    document.body.classList.remove("settings-overlay-open");
    appLayout.inert = false;
    settingsButton.classList.remove("active");
    settingsButton.setAttribute("aria-expanded", "false");
    selectSection(defaultSection);
    closeCallback();
    const target = focusReturnTarget?.focus ? focusReturnTarget : settingsButton;
    focusReturnTarget = null;
    target.focus();
  }

  function selectSection(sectionName) {
    const activeButton = navigationButtons.find(
      (button) => button.dataset.settingsSection === sectionName,
    );
    if (!activeButton) return false;
    navigationButtons.forEach((button) => updateNavigationButton(button, activeButton));
    sectionPanels.forEach((panel) => updateSectionPanel(panel, sectionName));
    return true;
  }

  function updateNavigationButton(button, activeButton) {
    const isActive = button === activeButton;
    button.classList.toggle("active", isActive);
    if (isActive) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }

  function updateSectionPanel(panel, sectionName) {
    const isActive = panel.dataset.settingsPanel === sectionName;
    panel.classList.toggle("hidden", !isActive);
    panel.setAttribute("aria-hidden", String(!isActive));
  }

  function closeFromBackdrop(event) {
    if (event.target === overlay) close();
  }

  function handleKeydown(event) {
    if (!isOpen()) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "Tab") keepFocusInside(event);
  }

  function keepFocusInside(event) {
    const focusableElements = [...dialog.querySelectorAll(focusableSelector)]
      .filter(isElementVisible);
    if (!focusableElements.length) return;
    const firstElement = focusableElements[0];
    const lastElement = focusableElements.at(-1);
    const activeElement = document.activeElement;
    if (event.shiftKey && activeElement === firstElement) moveFocus(event, lastElement);
    else if (!event.shiftKey && activeElement === lastElement) moveFocus(event, firstElement);
    else if (!dialog.contains(activeElement)) moveFocus(event, firstElement);
  }

  function isElementVisible(element) {
    if (element.disabled || element.closest(".hidden")) return false;
    return typeof element.getClientRects !== "function" || element.getClientRects().length > 0;
  }

  function moveFocus(event, target) {
    event.preventDefault();
    target.focus();
  }

  function isOpen() {
    return !overlay.classList.contains("hidden");
  }

  return { bind, close, isOpen, open, selectSection };
})();
