window.discordBotHistoryUi = (() => {
  const pageSize = 25;
  let showToast = () => {};
  let guildProvider = () => [];
  let modal = null;
  let offset = 0;
  let total = 0;
  let returnFocus = null;

  function bind(dependencies) {
    showToast = dependencies.showToast;
    guildProvider = dependencies.guilds;
    modal = createModal();
    document.body.append(modal);
    bindEvents();
  }

  function createModal() {
    const container = document.createElement("div");
    container.id = "discord-answer-history-modal";
    container.className = "modal-backdrop hidden";
    container.setAttribute("aria-hidden", "true");
    container.innerHTML = `
      <section class="discord-history-dialog" role="dialog" aria-modal="true" aria-labelledby="discord-history-title">
        <header><div><p class="eyebrow">AUDIT ODPOVĚDÍ</p><h2 id="discord-history-title">Historie odpovědí Discord bota</h2></div><button id="close-discord-history" class="icon-button" type="button" aria-label="Zavřít historii">×</button></header>
        <div class="discord-history-filters"><label>Server<select id="discord-history-guild"></select></label><label>Roomka<input id="discord-history-channel" placeholder="Discord channel ID" /></label><button id="refresh-discord-history" class="secondary-button" type="button">Filtrovat</button></div>
        <div id="discord-history-list" class="discord-history-list"></div>
        <div class="discord-history-pagination"><button id="discord-history-previous" class="quiet-button" type="button">Předchozí</button><span id="discord-history-page"></span><button id="discord-history-next" class="quiet-button" type="button">Další</button></div>
        <div class="discord-history-delete-actions"><button id="delete-discord-guild-history" class="danger-button" type="button">Smazat historii serveru</button><button id="delete-all-discord-history" class="danger-button" type="button">Smazat celou Discord historii</button></div>
        <article id="discord-history-detail" class="discord-history-detail hidden"></article>
      </section>`;
    return container;
  }

  function bindEvents() {
    find("close-discord-history").addEventListener("click", close);
    find("refresh-discord-history").addEventListener("click", () => loadPage(0));
    find("discord-history-previous").addEventListener("click", () => loadPage(offset - pageSize));
    find("discord-history-next").addEventListener("click", () => loadPage(offset + pageSize));
    find("delete-discord-guild-history").addEventListener("click", deleteGuildHistory);
    find("delete-all-discord-history").addEventListener("click", deleteAllHistory);
    modal.addEventListener("click", (event) => { if (event.target === modal) close(); });
    document.addEventListener("keydown", handleKeydown, true);
  }

  async function open(guildId = null) {
    returnFocus = document.activeElement;
    renderGuildOptions(guildId);
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    find("close-discord-history").focus();
    await loadPage(0);
  }

  function close() {
    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    find("discord-history-detail").classList.add("hidden");
    returnFocus?.focus?.();
    returnFocus = null;
  }

  function handleKeydown(event) {
    if (modal.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      return;
    }
    if (event.key === "Tab") trapFocus(event);
  }

  function trapFocus(event) {
    const focusable = [...modal.querySelectorAll(
      "button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]",
    )].filter((item) => !item.closest(".hidden"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) moveFocus(event, last);
    else if (!event.shiftKey && document.activeElement === last) moveFocus(event, first);
    else if (!modal.contains(document.activeElement)) moveFocus(event, first);
  }

  function moveFocus(event, target) {
    event.preventDefault();
    event.stopImmediatePropagation();
    target.focus();
  }

  function renderGuildOptions(selectedGuildId) {
    const select = find("discord-history-guild");
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "Všechny servery";
    const options = guildProvider().map((guild) => {
      const option = document.createElement("option");
      option.value = guild.guild_id;
      option.textContent = guild.guild_name;
      return option;
    });
    select.replaceChildren(all, ...options);
    select.value = selectedGuildId || "";
  }

  async function loadPage(nextOffset) {
    offset = Math.max(0, nextOffset);
    try {
      const page = await window.chatContext.listDiscordBotAnswers({
        limit: pageSize, offset, guildId: find("discord-history-guild").value || null,
        channelId: find("discord-history-channel").value.trim() || null,
      });
      total = page.total;
      renderList(page.items);
      renderPagination();
    } catch (error) { showToast(error.message, true); }
  }

  function renderList(items) {
    const rows = items.map((answer) => {
      const button = document.createElement("button");
      button.className = "discord-history-row";
      button.type = "button";
      button.append(
        textElement("strong", answer.question),
        textElement("span", `${answer.guild_name} · #${answer.channel_name} · ${answer.requester_name}`),
        textElement("small", `${formatDate(answer.created_at)} · ${answer.status}${answer.basis ? ` · ${basisLabel(answer.basis)}` : ""}`),
      );
      button.addEventListener("click", () => showDetail(answer.answer_id));
      return button;
    });
    if (!rows.length) rows.push(textElement("p", "Pro tento filtr nejsou žádné odpovědi."));
    find("discord-history-list").replaceChildren(...rows);
  }

  function renderPagination() {
    const pageNumber = total ? Math.floor(offset / pageSize) + 1 : 0;
    const pages = Math.ceil(total / pageSize);
    find("discord-history-page").textContent = `${pageNumber} / ${pages} · ${total} záznamů`;
    find("discord-history-previous").disabled = offset === 0;
    find("discord-history-next").disabled = offset + pageSize >= total;
  }

  async function showDetail(answerId) {
    try {
      const detail = await window.chatContext.getDiscordBotAnswer(answerId);
      const panel = find("discord-history-detail");
      panel.replaceChildren(
        detailHeader(detail),
        detailSection("Otázka", [textElement("p", detail.question)]),
        detailSection("Odpověď", [textElement("p", detail.answer || "Bez odpovědi")]),
        detailMetadata(detail),
        detailSection("Živý snapshot", contextRows(detail.recent_context)),
        detailSection("Nalezená evidence", evidenceRows(detail.evidence)),
        detailSection("Tool activity", jsonRows(detail.tool_activity)),
        detailSection("Varování a doručení", warningRows(detail)),
      );
      panel.classList.remove("hidden");
      panel.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) { showToast(error.message, true); }
  }

  function detailHeader(detail) {
    const header = document.createElement("header");
    header.append(textElement("h3", "Detail odpovědi"));
    const remove = textElement("button", "Smazat tento záznam");
    remove.type = "button";
    remove.className = "danger-button";
    remove.addEventListener("click", () => deleteOne(detail.answer_id));
    header.append(remove);
    return header;
  }

  function detailMetadata(detail) {
    const values = [
      `Autor: ${detail.requester_name} (${detail.requester_id})`,
      `Trigger: ${detail.trigger_type} · ${detail.trigger_message_id}`,
      `Model: ${detail.chat_provider_id || "—"} / ${detail.chat_model || "—"}`,
      `Režim: ${detail.retrieval_mode || "—"} · reasoning ${detail.reasoning_effort || "výchozí"}`,
      `Vyhodnocení: ${basisLabel(detail.basis)} · stav ${detail.status}`,
    ];
    return detailSection("Metadata", values.map((value) => textElement("p", value)));
  }

  function contextRows(messages = []) {
    return messages.length ? messages.map((message) => textElement(
      "p", `${formatDate(message.timestamp)} · ${message.author}: ${message.content}`,
    )) : [textElement("p", "Snapshot byl prázdný.")];
  }

  function evidenceRows(evidence = []) {
    return evidence.length ? evidence.map((item) => textElement(
      "p", `${item.evidence_id} · ${item.cited ? "citováno" : "nepoužito"} · ${item.origin}`
        + `${item.match_score == null ? "" : ` · skóre ${item.match_score.toFixed(3)}`}`
        + ` · ${item.author}: ${item.content}`,
    )) : [textElement("p", "Nebyla nalezena room evidence; odpověď použila obecné znalosti modelu.")];
  }

  function jsonRows(records = []) {
    return records.length ? records.map((record) => {
      const pre = textElement("pre", JSON.stringify(record, null, 2));
      return pre;
    }) : [textElement("p", "Žádná tool activity.")];
  }

  function warningRows(detail) {
    const rows = (detail.warnings || []).map((warning) => textElement("p", warning));
    if (detail.error_code) rows.push(textElement("p", `Chyba: ${detail.error_code}`));
    rows.push(textElement("p", `Discord message ID: ${(detail.response_message_ids || []).join(", ") || "—"}`));
    return rows;
  }

  function detailSection(title, rows) {
    const section = document.createElement("section");
    section.append(textElement("h4", title), ...rows);
    return section;
  }

  async function deleteOne(answerId) {
    if (!confirm("Smazat tento audit? Discord zprávy ani archiv se nesmažou.")) return;
    await executeDelete(() => window.chatContext.deleteDiscordBotAnswer(answerId));
  }

  async function deleteGuildHistory() {
    const guildId = find("discord-history-guild").value;
    if (!guildId) return showToast("Nejdřív vyberte konkrétní server.", true);
    if (!confirm("Smazat celou historii vybraného serveru?")) return;
    await executeDelete(() => window.chatContext.deleteDiscordBotAnswers(guildId));
  }

  async function deleteAllHistory() {
    if (!confirm("Smazat celou historii odpovědí Discord bota?")) return;
    await executeDelete(() => window.chatContext.deleteDiscordBotAnswers());
  }

  async function executeDelete(operation) {
    try {
      await operation();
      find("discord-history-detail").classList.add("hidden");
      await loadPage(0);
      showToast("Historie Discord bota byla smazána.");
    } catch (error) { showToast(error.message, true); }
  }

  function textElement(tag, content) {
    const node = document.createElement(tag);
    node.textContent = content;
    return node;
  }

  function basisLabel(basis) {
    return basis === "room_context" ? "použit kontext roomky" : "obecné znalosti";
  }

  function formatDate(value) { return value ? new Date(value).toLocaleString("cs-CZ") : "—"; }
  function find(id) { return document.getElementById(id); }

  return { bind, close, open };
})();
