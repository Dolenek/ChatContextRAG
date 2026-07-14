window.contextPanel = (() => {
  const previewLimit = 4;
  const contextList = document.querySelector("#context-list");
  const emptyState = document.querySelector("#context-empty");
  const detailButton = document.querySelector("#open-context-detail");
  let currentSources = [];

  function showSources(sources = []) {
    currentSources = [...sources];
    const cards = currentSources.slice(0, previewLimit).map((source, index) =>
      window.chatSources.createChatSourceCard(source, { index: index + 1 }));
    contextList.replaceChildren(...cards);
    emptyState.classList.toggle("hidden", cards.length > 0);
    detailButton.disabled = currentSources.length === 0;
    updateCounts(currentSources.length);
    window.contextDetailModal?.setSources(currentSources);
  }

  function updateCounts(count) {
    document.querySelector("#context-count").textContent = String(count);
    document.querySelector("#context-toggle-count").textContent = String(count);
    document.querySelector("#context-detail-label").textContent =
      `Zobrazit kompletní kontext (${count})`;
  }

  function clear() {
    showSources([]);
  }

  return { clear, getSources: () => [...currentSources], showSources };
})();
