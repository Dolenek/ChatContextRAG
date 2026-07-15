(function bindFieldHelpDismissal() {
  let triggerFocusedBeforePointer = false;

  document.addEventListener("pointerdown", (event) => {
    const trigger = event.target.closest?.(".field-help-term");
    triggerFocusedBeforePointer = Boolean(trigger && document.activeElement === trigger);
  });

  document.addEventListener("click", (event) => {
    const trigger = event.target.closest?.(".field-help-term");
    if (trigger) {
      event.preventDefault();
      if (triggerFocusedBeforePointer) trigger.blur();
      else trigger.focus();
      return;
    }
    document.querySelectorAll(".field-help-term").forEach((term) => term.blur());
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.activeElement?.closest?.(".field-help-term")?.blur();
  });
}());
