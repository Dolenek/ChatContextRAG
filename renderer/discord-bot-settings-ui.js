window.discordBotSettingsUi = (() => {
  const root = document.querySelector("#discord-bot-settings-root");
  let showToast = () => {};
  let applicationSettings = null;
  let botSettings = { model: {}, guilds: [], available_guilds: [] };
  let currentGuild = null;
  let availableRoles = [];

  function bind(dependencies) {
    showToast = dependencies.showToast;
    buildMarkup();
    bindConnection();
    bindModelForm();
    bindPermissions();
    window.discordBotHistoryUi.bind({ showToast, guilds: guildOptions });
    window.chatContext.onDiscordBotProgress(() => void refreshStatus());
  }

  function buildMarkup() {
    root.innerHTML = `
      <div class="settings-section-stack discord-settings-stack">
        <section class="settings-card discord-connection-card">
          <div><h3>Připojení</h3><p id="discord-bot-settings-status">Načítám stav…</p></div>
          <div class="discord-token-row"><input id="discord-bot-settings-token" type="password" autocomplete="off" placeholder="Discord bot token" /><button id="discord-bot-settings-connect" class="primary-button" type="button">Připojit</button></div>
          <div class="settings-form-actions"><button id="discord-bot-settings-invite" class="secondary-button" type="button">Pozvat na server</button><button id="discord-bot-settings-disconnect" class="danger-button" type="button">Odpojit a odstranit token</button></div>
          <p class="fine-print">Vyžaduje privileged intents Message Content a Server Members. Bot odpovídá na @mention a reply na svou zprávu.</p>
        </section>
        <section class="settings-card"><h3>Model odpovědí</h3>
          <form id="discord-bot-model-form" class="settings-form settings-form-grid">
            <label for="discord-bot-model">Provider a model</label><select id="discord-bot-model" required></select>
            <label for="discord-bot-reasoning">Reasoning effort</label><select id="discord-bot-reasoning"><option value="">Výchozí</option><option>none</option><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option></select>
            <label for="discord-bot-retrieval">Retrieval</label><select id="discord-bot-retrieval"><option value="deterministic">Deterministic</option><option value="adaptive">Adaptive</option></select>
            <label for="discord-bot-evidence-limit">Adaptive evidence limit</label><input id="discord-bot-evidence-limit" type="number" min="4000" max="100000" step="1000" value="24000" />
            <button class="primary-button" type="submit">Uložit model bota</button>
          </form>
        </section>
        <section class="settings-card"><h3>Oprávnění serveru</h3><p>Role a uživatelé se sjednocují. Prázdný seznam neopravňuje nikoho; administrátoři nemají výjimku.</p>
          <label for="discord-bot-guild">Server</label><select id="discord-bot-guild"></select>
          <form id="discord-bot-permissions-form" class="discord-permission-grid">
            <fieldset><legend>Správa synchronizace</legend><div id="discord-sync-subjects"></div><div class="member-search"><input id="discord-sync-member-query" placeholder="Vyhledat uživatele" /><button class="secondary-button" data-member-search="sync" type="button">Hledat</button></div><div id="discord-sync-member-results"></div></fieldset>
            <fieldset><legend>Pokládání otázek</legend><div id="discord-ask-subjects"></div><div class="member-search"><input id="discord-ask-member-query" placeholder="Vyhledat uživatele" /><button class="secondary-button" data-member-search="ask" type="button">Hledat</button></div><div id="discord-ask-member-results"></div></fieldset>
            <div class="settings-form-actions discord-permission-actions"><button class="primary-button" type="submit">Uložit oprávnění</button><button id="show-discord-history" class="secondary-button" type="button">Zobrazit historii odpovědí</button></div>
          </form>
        </section>
      </div>`;
  }

  function bindConnection() {
    element("discord-bot-settings-connect").addEventListener("click", connect);
    element("discord-bot-settings-disconnect").addEventListener("click", disconnect);
    element("discord-bot-settings-invite").addEventListener(
      "click", () => window.chatContext.inviteDiscordBot(),
    );
  }

  function bindModelForm() {
    element("discord-bot-model-form").addEventListener("submit", saveModel);
    element("discord-bot-retrieval").addEventListener("change", updateEvidenceVisibility);
  }

  function bindPermissions() {
    element("discord-bot-guild").addEventListener("change", selectGuild);
    element("discord-bot-permissions-form").addEventListener("submit", savePermissions);
    root.querySelectorAll("[data-member-search]").forEach((button) => {
      button.addEventListener("click", () => searchMembers(button.dataset.memberSearch));
    });
    element("show-discord-history").addEventListener(
      "click", () => window.discordBotHistoryUi.open(currentGuild?.guild_id),
    );
  }

  async function refresh(nextApplicationSettings = applicationSettings) {
    applicationSettings = nextApplicationSettings;
    try {
      const [settings] = await Promise.all([
        window.chatContext.getDiscordBotSettings(), refreshStatus(),
      ]);
      botSettings = settings;
      renderModelOptions();
      renderGuilds();
      await loadSelectedGuild();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function refreshStatus() {
    const status = await window.chatContext.getDiscordBotStatus();
    const suffix = status.lastError ? ` · ${status.lastError}` : "";
    element("discord-bot-settings-status").textContent = status.connected
      ? `${status.botName} · ${status.trackedChannels} synchronizovaných kanálů${suffix}`
      : `Bot není připojený${suffix}`;
    element("discord-bot-settings-invite").disabled = !status.connected;
    element("discord-bot-settings-disconnect").disabled = !status.connected;
  }

  async function connect() {
    const tokenInput = element("discord-bot-settings-token");
    if (!tokenInput.value.trim()) return showToast("Vložte Discord bot token.", true);
    await run(async () => {
      await window.chatContext.connectDiscordBot(tokenInput.value.trim());
      tokenInput.value = "";
      await refresh();
    }, "Discord bot je připojený.");
  }

  async function disconnect() {
    await run(async () => {
      await window.chatContext.disconnectDiscordBot();
      await refreshStatus();
    }, "Discord bot byl odpojen a token odstraněn.");
  }

  function renderModelOptions() {
    const select = element("discord-bot-model");
    const models = applicationSettings?.chatModels || [];
    select.replaceChildren(...models.map(modelOption));
    const configured = botSettings.model || {};
    select.value = modelValue(configured.chat_provider_id || "", configured.chat_model || "");
    element("discord-bot-reasoning").value = configured.reasoning_effort || "";
    element("discord-bot-retrieval").value = configured.retrieval_mode || "deterministic";
    element("discord-bot-evidence-limit").value = configured.evidence_character_limit || 24000;
    updateEvidenceVisibility();
  }

  function modelOption(model) {
    const option = document.createElement("option");
    option.value = modelValue(model.provider_id, model.model);
    option.textContent = `${providerName(model.provider_id)} · ${model.label || model.model}`;
    return option;
  }

  function providerName(providerId) {
    return applicationSettings?.providers.find((item) => item.provider_id === providerId)?.name
      || providerId;
  }

  async function saveModel(event) {
    event.preventDefault();
    const [chatProviderId, chatModel] = JSON.parse(element("discord-bot-model").value);
    const adaptive = element("discord-bot-retrieval").value === "adaptive";
    await run(async () => {
      botSettings.model = await window.chatContext.updateDiscordBotModel({
        chat_provider_id: chatProviderId, chat_model: chatModel,
        reasoning_effort: element("discord-bot-reasoning").value || null,
        retrieval_mode: adaptive ? "adaptive" : "deterministic",
        evidence_character_limit: adaptive ? Number(element("discord-bot-evidence-limit").value) : null,
      });
    }, "Model Discord bota byl uložen.");
  }

  function updateEvidenceVisibility() {
    element("discord-bot-evidence-limit").disabled =
      element("discord-bot-retrieval").value !== "adaptive";
  }

  function renderGuilds() {
    const select = element("discord-bot-guild");
    const previous = select.value;
    select.replaceChildren(...guildOptions().map((guild) => {
      const option = document.createElement("option");
      option.value = guild.guild_id;
      option.textContent = guild.available ? guild.guild_name : `${guild.guild_name} (nedostupný)`;
      return option;
    }));
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }

  async function selectGuild() { await loadSelectedGuild(); }

  async function loadSelectedGuild() {
    const guildId = element("discord-bot-guild").value;
    currentGuild = botSettings.guilds.find((guild) => guild.guild_id === guildId)
      || botSettings.available_guilds.find((guild) => guild.guild_id === guildId);
    if (!currentGuild) return renderPermissionSubjects();
    currentGuild.sync_subjects ||= [];
    currentGuild.ask_subjects ||= [];
    const subjects = [...currentGuild.sync_subjects, ...currentGuild.ask_subjects];
    try {
      availableRoles = await window.chatContext.getDiscordGuildRoles(guildId);
      const availability = await window.chatContext.getDiscordSubjectAvailability(
        guildId, subjects,
      );
      applyAvailability(subjects, availability);
    } catch (_error) {
      availableRoles = [];
      subjects.forEach((subject) => { subject.available = false; });
    }
    renderPermissionSubjects();
  }

  function guildOptions() {
    const available = (botSettings.available_guilds || []).map((guild) => ({
      ...guild, available: true,
    }));
    const availableIds = new Set(available.map((guild) => guild.guild_id));
    const unavailable = (botSettings.guilds || [])
      .filter((guild) => !availableIds.has(guild.guild_id))
      .map((guild) => ({ ...guild, available: false }));
    return [...available, ...unavailable];
  }

  function applyAvailability(subjects, availability) {
    const states = new Map(availability.map((item) => [
      `${item.subject_type}:${item.subject_id}`, item.available,
    ]));
    subjects.forEach((subject) => {
      subject.available = states.get(`${subject.subject_type}:${subject.subject_id}`) ?? false;
    });
  }

  function renderPermissionSubjects() {
    ["sync", "ask"].forEach((capability) => {
      const subjects = currentGuild?.[`${capability}_subjects`] || [];
      const container = element(`discord-${capability}-subjects`);
      const liveIds = new Set(availableRoles.map((role) => role.subject_id));
      const rows = availableRoles.map((role) => roleCheckbox(capability, role, subjects));
      subjects.filter((subject) => subject.subject_type === "user" || !liveIds.has(subject.subject_id))
        .forEach((subject) => rows.push(subjectChip(capability, subject)));
      container.replaceChildren(...rows);
    });
  }

  function roleCheckbox(capability, role, subjects) {
    const label = document.createElement("label");
    label.className = "discord-subject-option";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = subjects.some((subject) => subject.subject_id === role.subject_id);
    checkbox.addEventListener("change", () => toggleRole(capability, role, checkbox.checked));
    label.append(checkbox, document.createTextNode(role.display_name));
    return label;
  }

  function subjectChip(capability, subject) {
    const chip = document.createElement("button");
    chip.className = "discord-subject-chip";
    chip.type = "button";
    const unavailable = subject.available === false ? " (nedostupný/á)" : "";
    chip.textContent = `${subject.display_name}${unavailable} ×`;
    chip.addEventListener("click", () => removeSubject(capability, subject.subject_id));
    return chip;
  }

  function toggleRole(capability, role, selected) {
    if (selected) addSubject(capability, { ...role, subject_type: "role" });
    else removeSubject(capability, role.subject_id);
  }

  function addSubject(capability, subject) {
    const subjects = currentGuild[`${capability}_subjects`];
    if (!subjects.some((item) => item.subject_id === subject.subject_id)) subjects.push(subject);
    renderPermissionSubjects();
  }

  function removeSubject(capability, subjectId) {
    currentGuild[`${capability}_subjects`] = currentGuild[`${capability}_subjects`]
      .filter((subject) => subject.subject_id !== subjectId);
    renderPermissionSubjects();
  }

  async function searchMembers(capability) {
    if (!currentGuild) return;
    const query = element(`discord-${capability}-member-query`).value.trim();
    const results = await window.chatContext.searchDiscordGuildMembers(currentGuild.guild_id, query);
    element(`discord-${capability}-member-results`).replaceChildren(
      ...results.map((member) => memberResult(capability, member)),
    );
  }

  function memberResult(capability, member) {
    const button = document.createElement("button");
    button.className = "quiet-button discord-member-result";
    button.type = "button";
    button.textContent = `+ ${member.display_name}`;
    button.addEventListener("click", () => addSubject(
      capability, { ...member, subject_type: "user" },
    ));
    return button;
  }

  async function savePermissions(event) {
    event.preventDefault();
    if (!currentGuild) return;
    await run(async () => {
      currentGuild = await window.chatContext.updateDiscordGuildPermissions({
        guild_id: currentGuild.guild_id, guild_name: currentGuild.guild_name,
        sync_subjects: currentGuild.sync_subjects, ask_subjects: currentGuild.ask_subjects,
      });
    }, "Oprávnění Discord serveru byla uložena.");
  }

  async function run(operation, successMessage) {
    try { await operation(); showToast(successMessage); }
    catch (error) { showToast(error.message, true); }
  }

  function modelValue(providerId, model) { return JSON.stringify([providerId, model]); }
  function element(id) { return document.getElementById(id); }

  return { bind, refresh };
})();
