(function exposeConnectionSettingsUi() {
  let showToast = () => {};
  let acknowledgedConnectionOrigin = null;

  function bind(dependencies) {
    showToast = dependencies.showToast;
    document.querySelector("#connection-mode").addEventListener("change", updateFields);
    document.querySelector("#connection-url").addEventListener("input", connectionUrlChanged);
    document.querySelector("#insecure-http-acknowledged").addEventListener(
      "change", () => window.archiveMigrationUi.connectionSelectionChanged(),
    );
    document.querySelector("#connection-form").addEventListener("submit", saveTarget);
    document.querySelector("#test-connection-button").addEventListener("click", testTarget);
  }

  async function refresh() {
    try {
      const target = await window.chatContext.getConnectionTarget();
      const card = document.querySelector("#connection-settings-card");
      card.classList.toggle("hidden", target.mode === "web");
      if (target.mode === "web") return;
      renderTarget(target);
      await window.archiveMigrationUi.refresh(target);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function renderTarget(target) {
    document.querySelector("#connection-mode").value = target.mode;
    document.querySelector("#connection-url").value = target.baseUrl || "";
    acknowledgedConnectionOrigin = target.insecureHttpAcknowledged ? target.baseUrl : null;
    document.querySelector("#insecure-http-acknowledged").checked = Boolean(
      target.insecureHttpAcknowledged,
    );
    const tokenInput = document.querySelector("#connection-token");
    tokenInput.value = "";
    tokenInput.placeholder = target.hasToken
      ? "Token je uložený; prázdné pole jej zachová" : "Vložte desktop API token";
    document.querySelector("#connection-status").textContent = target.mode === "remote"
      ? `Aktivní vzdálený workspace: ${target.baseUrl}` : "Aktivní lokální workspace";
    updateFields();
  }

  function connectionInput() {
    return {
      mode: document.querySelector("#connection-mode").value,
      baseUrl: document.querySelector("#connection-url").value.trim(),
      token: document.querySelector("#connection-token").value.trim(),
      insecureHttpAcknowledged: document.querySelector(
        "#insecure-http-acknowledged",
      ).checked,
    };
  }

  function updateFields() {
    const remote = document.querySelector("#connection-mode").value === "remote";
    document.querySelector("#connection-url").disabled = !remote;
    document.querySelector("#connection-token").disabled = !remote;
    document.querySelector("#test-connection-button").disabled = !remote;
    updateInsecureHttpWarning(remote);
    window.archiveMigrationUi.connectionSelectionChanged();
  }

  function connectionUrlChanged() {
    const input = document.querySelector("#connection-url");
    const origin = window.connectionSecurity.normalizedOrigin(input.value.trim());
    document.querySelector("#insecure-http-acknowledged").checked = Boolean(
      origin && origin === acknowledgedConnectionOrigin,
    );
    updateFields();
  }

  function updateInsecureHttpWarning(remote) {
    const url = document.querySelector("#connection-url").value.trim();
    const acknowledgement = document.querySelector("#insecure-http-acknowledged");
    const acknowledgementRequired = remote
      && window.connectionSecurity.requiresInsecureHttpAcknowledgement(url);
    const origin = window.connectionSecurity.normalizedOrigin(url);
    if (acknowledgementRequired && origin === acknowledgedConnectionOrigin) {
      acknowledgement.checked = true;
    }
    if (!acknowledgementRequired) acknowledgement.checked = false;
    acknowledgement.disabled = !acknowledgementRequired;
    document.querySelector("#insecure-http-warning").classList.toggle(
      "hidden", !acknowledgementRequired,
    );
  }

  async function testTarget() {
    await performTargetAction(
      () => window.chatContext.testConnectionTarget(connectionInput()),
      "Připojení k serveru funguje.",
    );
  }

  async function saveTarget(event) {
    event.preventDefault();
    await performTargetAction(
      () => window.chatContext.saveConnectionTarget(connectionInput()),
      "Cíl byl uložen, aplikace se restartuje.",
    );
  }

  async function performTargetAction(action, successMessage) {
    try {
      await action();
      showToast(successMessage);
    } catch (error) {
      showToast(error.message, true);
    }
  }

  window.connectionSettingsUi = { bind, refresh };
}());
