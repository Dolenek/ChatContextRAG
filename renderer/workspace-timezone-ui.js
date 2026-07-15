window.workspaceTimezoneUi = (() => {
  let showToast = () => {};
  let projectTimezone = () => null;

  function bind(dependencies) {
    showToast = dependencies.showToast;
    projectTimezone = dependencies.projectTimezone;
    if (document.querySelector("#workspace-timezone-form")) return;
    const card = document.createElement("section");
    const heading = document.createElement("h3");
    const description = document.createElement("p");
    const form = document.createElement("form");
    const label = document.createElement("label");
    const input = document.createElement("input");
    const suggestions = document.createElement("datalist");
    const button = document.createElement("button");
    card.className = "settings-card";
    heading.textContent = "Časová zóna archivu";
    description.textContent = "Určuje kalendářní hranice časově omezeného hledání.";
    form.id = "workspace-timezone-form";
    form.className = "settings-form settings-form-grid";
    label.htmlFor = "workspace-timezone";
    label.textContent = "IANA časová zóna";
    input.id = "workspace-timezone";
    input.setAttribute("list", "workspace-timezone-options");
    input.setAttribute("autocomplete", "off");
    input.placeholder = "Např. Europe/Prague";
    input.required = true;
    suggestions.id = "workspace-timezone-options";
    button.type = "submit";
    button.className = "primary-button";
    button.textContent = "Uložit časovou zónu";
    form.append(label, input, suggestions, button);
    card.append(heading, description, form);
    document.querySelector("#settings-workspace-panel .settings-section-heading")
      .insertAdjacentElement("afterend", card);
    appendTimezoneSuggestions(suggestions);
    form.addEventListener("submit", save);
  }

  function appendTimezoneSuggestions(suggestions) {
    timezoneNames().forEach((name) => {
      const option = document.createElement("option");
      option.value = name;
      suggestions.append(option);
    });
  }

  function render(workspace) {
    const input = document.querySelector("#workspace-timezone");
    if (input && workspace?.timezone_name) input.value = workspace.timezone_name;
  }

  async function save(event) {
    event.preventDefault();
    const timezoneInput = document.querySelector("#workspace-timezone");
    const timezoneName = timezoneInput.value;
    await window.settingsMutationUi.run({
      key: "workspace-timezone", control: event.submitter,
      pendingText: "Ukládám…", apply: () => projectTimezone(timezoneName),
      execute: () => window.chatContext.updateWorkspaceSettings(timezoneName),
      rollback: (previousTimezone) => {
        projectTimezone(previousTimezone);
        timezoneInput.value = previousTimezone;
        timezoneInput.focus();
      },
      successMessage: "Časová zóna workspace byla uložena.",
    });
  }

  function timezoneNames() {
    const supported = Intl.supportedValuesOf?.("timeZone") || [];
    return [...new Set(["UTC", "Europe/Prague", ...supported])].sort();
  }

  return { bind, render };
})();
