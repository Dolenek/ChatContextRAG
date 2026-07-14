window.contextPanel = (() => {
  const previewLimit = 5;
  const contextList = document.querySelector("#context-list");
  const contextSection = document.querySelector("#context-section");
  const contextHeader = document.querySelector(".context-header");
  const emptyState = document.querySelector("#context-empty");
  const detailButton = document.querySelector("#open-context-detail");
  const liveStatus = document.querySelector("#context-update-status");
  let currentSources = [];
  let scheduledLayout = false;

  function showSources(sources = []) {
    currentSources = normalizeLegacyScores(sources);
    const cards = currentSources.slice(0, previewLimit).map((source, index) =>
      window.chatSources.createChatSourceCard(source, {
        index: index + 1, onLayoutChange: schedulePreviewLayout,
      }));
    contextList.replaceChildren(...cards);
    emptyState.classList.toggle("hidden", cards.length > 0);
    detailButton.disabled = currentSources.length === 0;
    updateCounts(currentSources.length);
    window.contextDetailModal?.setSources(currentSources);
    schedulePreviewLayout();
  }

  function normalizeLegacyScores(sources) {
    const highest = Math.max(0, ...sources.map((source) =>
      Math.max(0, Number(source.similarity_score) || 0)));
    return sources.map((source) => ({
      ...source,
      match_score: source.match_score == null
        ? (highest ? Math.max(0, Number(source.similarity_score) || 0) / highest : 0)
        : source.match_score,
    }));
  }

  function schedulePreviewLayout() {
    if (scheduledLayout) return;
    scheduledLayout = true;
    scheduleFrame(() => {
      scheduledLayout = false;
      fitPreviewCards();
    });
  }

  function fitPreviewCards() {
    const cards = [...(contextList?.children || [])];
    if (!cards.length || !contextSection?.getBoundingClientRect) return;
    cards.forEach((card) => card.classList.remove("preview-hidden"));
    contextSection.scrollTop = 0;
    const availableBottom = contextSection.getBoundingClientRect().bottom;
    const cardBottoms = cards.map((card) => card.getBoundingClientRect().bottom);
    const fittingCount = calculateFittingCardCount(cardBottoms, availableBottom);
    const visibleCount = Math.max(fittingCount, expandedCardCount(cards));
    cards.forEach((card, index) =>
      card.classList.toggle("preview-hidden", index >= visibleCount));
  }

  function expandedCardCount(cards) {
    return cards.reduce((requiredCount, card, index) =>
      card.querySelector?.(".source-chunk:not([hidden])")
        ? index + 1 : requiredCount, 0);
  }

  function calculateFittingCardCount(cardBottoms, availableBottom) {
    if (!cardBottoms.length) return 0;
    const fitting = cardBottoms.filter((bottom) => bottom <= availableBottom + 1).length;
    return Math.max(1, Math.min(previewLimit, fitting));
  }

  function updateCounts(count) {
    document.querySelector("#context-count").textContent = String(count);
    document.querySelector("#context-toggle-count").textContent = String(count);
    document.querySelector("#context-detail-label").textContent =
      `Zobrazit kompletní kontext (${count})`;
  }

  function flash() {
    if (liveStatus) liveStatus.textContent = "";
    contextHeader.classList.remove("context-refreshed");
    scheduleFrame(() => scheduleFrame(() => {
      contextHeader.classList.add("context-refreshed");
      if (liveStatus) liveStatus.textContent = "Použitý kontext aktualizován";
      setTimeout(() => contextHeader.classList.remove("context-refreshed"), 700);
    }));
  }

  function scheduleFrame(callback) {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(callback);
    else if (typeof setTimeout === "function") setTimeout(callback, 0);
    else callback();
  }

  function clear() {
    showSources([]);
  }

  function watchSize() {
    if (typeof ResizeObserver !== "function" || !contextSection || !contextList) return;
    const observer = new ResizeObserver(schedulePreviewLayout);
    observer.observe(contextSection);
    observer.observe(contextList);
  }

  watchSize();
  window.addEventListener?.("resize", schedulePreviewLayout);
  return {
    calculateFittingCardCount, clear, flash,
    getSources: () => [...currentSources], showSources,
  };
})();
