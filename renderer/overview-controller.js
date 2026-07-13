window.overviewController = (() => {
  const pageSize = 50;
  let offset = 0;
  let latestOverview = null;

  async function refresh() {
    offset = 0;
    document.querySelector("#database-chunks").replaceChildren();
    return load(false);
  }

  async function loadMore() {
    return load(true);
  }

  async function load(append) {
    setBusy(true);
    try {
      const overview = await window.chatContext.getDatabaseOverview(pageSize, offset);
      latestOverview = overview;
      renderOverview(overview, append);
      offset += overview.chunks.length;
      return overview;
    } catch (error) {
      window.appUi?.showToast(error.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function renderOverview(overview, append) {
    window.contextPanel.renderOverview(overview);
    window.indexingControls.render(
      overview.indexing_jobs || [], overview.pending_message_count || 0,
    );
    renderOverviewStats(overview);
    renderCountList("#channel-counts", overview.channels);
    renderCountList("#author-counts", overview.authors);
    renderCountList("#model-counts", overview.embedding_models);
    const chunkCards = overview.chunks.map(createDatabaseChunkCard);
    const chunkList = document.querySelector("#database-chunks");
    append ? chunkList.append(...chunkCards) : chunkList.replaceChildren(...chunkCards);
    document.querySelector("#chunk-range").textContent =
      `Zobrazeno ${overview.offset + overview.chunks.length} z ${overview.total_chunks}`;
    document.querySelector("#load-more-chunks-button")
      .classList.toggle("hidden", !overview.has_more);
  }

  function renderOverviewStats(overview) {
    const stats = [
      ["Chunky", overview.total_chunks],
      ["Zdrojové zprávy", overview.total_source_messages],
      ["Raw zprávy", overview.raw_message_count],
      ["Unikátní texty", overview.unique_content_count],
      ["Přesné duplicity", overview.duplicate_message_count],
      ["Zaindexované zprávy", overview.indexed_message_count],
      ["Čeká na index", overview.pending_message_count],
      ["Velikost databáze", overview.database_size],
      ["Konverzace", overview.total_channels],
      ["Autoři", overview.total_authors],
      ["Nejstarší zpráva", formatDate(overview.oldest_message_at)],
      ["Nejnovější zpráva", formatDate(overview.newest_message_at)],
    ];
    document.querySelector("#overview-stats")
      .replaceChildren(...stats.map(([label, value]) => createStatCard(label, value)));
  }

  function createStatCard(label, value) {
    const card = document.createElement("article");
    const valueElement = document.createElement("strong");
    const labelElement = document.createElement("span");
    card.className = "stat-card";
    valueElement.textContent = value ?? "—";
    labelElement.textContent = label;
    card.append(valueElement, labelElement);
    return card;
  }

  function renderCountList(selector, counts = []) {
    const entries = counts.map((item) => {
      const row = document.createElement("div");
      const label = document.createElement("span");
      const count = document.createElement("strong");
      label.textContent = item.label;
      count.textContent = item.count;
      row.append(label, count);
      return row;
    });
    if (!entries.length) entries.push(createEmptyLabel("Zatím bez dat"));
    document.querySelector(selector).replaceChildren(...entries);
  }

  function createDatabaseChunkCard(chunk) {
    const card = document.createElement("article");
    const header = document.createElement("div");
    const content = document.createElement("p");
    const footer = document.createElement("small");
    card.className = "database-chunk-card";
    header.className = "chunk-meta";
    header.textContent = `${chunk.channel || "Bez konverzace"} · ${chunk.authors.join(", ")} · ${formatDate(chunk.started_at)}`;
    content.textContent = chunk.content;
    footer.textContent = `${chunk.embedding_model} · ${chunk.source_message_ids.length} zdrojových zpráv · ID ${chunk.chunk_id.slice(0, 12)}`;
    card.append(header, content, footer);
    return card;
  }

  function createEmptyLabel(text) {
    const label = document.createElement("span");
    label.className = "empty-label";
    label.textContent = text;
    return label;
  }

  function formatDate(value) {
    return value ? new Date(value).toLocaleString("cs-CZ") : "Bez času";
  }

  function setBusy(isBusy) {
    const refreshButton = document.querySelector("#refresh-overview-button");
    refreshButton.disabled = isBusy;
    refreshButton.childNodes[1].textContent = isBusy ? "Načítám…" : "Obnovit";
  }

  return { getLatest: () => latestOverview, loadMore, refresh };
})();
