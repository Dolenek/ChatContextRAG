window.overviewBreakdownsView = (() => {
  const pageSize = 50;
  const maximumAgeMs = 30000;
  const definitions = {
    channels: definition("#channel-counts", "#channel-total", "#load-more-channels"),
    authors: definition("#author-counts", "#author-total", "#load-more-authors"),
    "embedding-models": definition(
      "#model-counts", "#model-total", "#load-more-models",
    ),
  };
  const states = new Map();

  function definition(container, total, button) {
    return { container, total, button };
  }

  function initialize() {
    Object.entries(definitions).forEach(([dimension, view]) => {
      states.set(dimension, freshState());
      document.querySelector(view.button).addEventListener(
        "click", () => loadNext(dimension),
      );
      renderLoading(view.container);
    });
  }

  function freshState() {
    return { nextOffset: 0, hasMore: false, seenLabels: new Set(), failed: false };
  }

  async function loadInitial(force = false) {
    await Promise.all(Object.keys(definitions).map((dimension) =>
      loadFirstPage(dimension, force)));
  }

  async function loadFirstPage(dimension, force) {
    const cacheKey = pageCacheKey(dimension);
    const cached = window.workspaceCache.peek(cacheKey);
    if (cached) renderPage(dimension, cached, false);
    try {
      const page = await window.workspaceCache.load(
        cacheKey, () => requestPage(dimension, 0), maximumAgeMs, force,
      );
      renderPage(dimension, page, false);
    } catch (error) {
      renderFailure(dimension, !cached);
      window.appUi?.showToast(error.message, true);
    }
  }

  async function loadNext(dimension) {
    const state = states.get(dimension);
    const offset = state.nextOffset;
    setBusy(dimension, true);
    try {
      const page = await requestPage(dimension, offset);
      renderPage(dimension, page, offset > 0);
    } catch (error) {
      state.failed = true;
      updateButton(dimension);
      window.appUi?.showToast(error.message, true);
    } finally {
      setBusy(dimension, false);
    }
  }

  function requestPage(dimension, offset) {
    return window.chatContext.getDatabaseBreakdownPage(dimension, pageSize, offset);
  }

  function renderPage(dimension, page, append) {
    if (page.summary_ready === false) {
      renderProjectionPreparing(dimension);
      return;
    }
    const view = definitions[dimension];
    const state = append ? states.get(dimension) : freshState();
    if (!append) states.set(dimension, state);
    const rows = uniqueItems(page.items || [], state).map((item, index) =>
      createCountRow(item, page.offset + index));
    const container = document.querySelector(view.container);
    if (append) container.append(...rows);
    else container.replaceChildren(...rows);
    if (!container.children.length) container.replaceChildren(createEmptyLabel());
    state.nextOffset = page.next_offset ?? page.offset + (page.items || []).length;
    state.hasMore = Boolean(page.has_more);
    state.failed = false;
    document.querySelector(view.total).textContent = `${formatNumber(page.total)} celkem`;
    updateButton(dimension);
  }

  function renderProjectionPreparing(dimension) {
    const view = definitions[dimension];
    states.set(dimension, freshState());
    document.querySelector(view.container).replaceChildren(
      createEmptyLabel("Připravuji souhrn…"),
    );
    document.querySelector(view.total).textContent = "—";
    updateButton(dimension);
  }

  function uniqueItems(items, state) {
    return items.filter((item) => {
      if (state.seenLabels.has(item.label)) return false;
      state.seenLabels.add(item.label);
      return true;
    });
  }

  function createCountRow(item, index) {
    const row = document.createElement("div");
    const rank = document.createElement("span");
    const label = document.createElement("span");
    const count = document.createElement("strong");
    row.className = "overview-count-row";
    rank.className = "overview-count-rank";
    rank.textContent = index + 1;
    label.className = "overview-count-label";
    label.textContent = item.label;
    label.title = item.label;
    count.textContent = formatNumber(item.count);
    row.append(rank, label, count);
    return row;
  }

  function renderFailure(dimension, replaceContent) {
    const state = states.get(dimension);
    state.failed = true;
    state.hasMore = true;
    if (replaceContent) {
      document.querySelector(definitions[dimension].container)
        .replaceChildren(createEmptyLabel("Data se nepodařilo načíst"));
    }
    updateButton(dimension);
  }

  function updateButton(dimension) {
    const state = states.get(dimension);
    const button = document.querySelector(definitions[dimension].button);
    button.classList.toggle("hidden", !state.hasMore && !state.failed);
    button.textContent = state.failed ? "Zkusit znovu" : "Zobrazit další";
  }

  function setBusy(dimension, busy) {
    const view = definitions[dimension];
    const button = document.querySelector(view.button);
    document.querySelector(view.container).setAttribute("aria-busy", String(busy));
    button.disabled = busy;
    if (busy) button.textContent = "Načítám…";
    else updateButton(dimension);
  }

  function renderLoading(selector) {
    document.querySelector(selector).replaceChildren(createEmptyLabel("Načítám…"));
  }

  function createEmptyLabel(text = "Zatím bez dat") {
    const label = document.createElement("span");
    label.className = "empty-label";
    label.textContent = text;
    return label;
  }

  function pageCacheKey(dimension) {
    return `database-breakdown:${dimension}:0`;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("cs-CZ");
  }

  initialize();
  return { loadInitial, loadNext, pageCacheKey };
})();
