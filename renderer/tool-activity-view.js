window.toolActivityView = (() => {
  function createLiveRegion() {
    const region = document.createElement("ol");
    region.className = "tool-activity-live hidden";
    region.setAttribute("aria-label", "Probíhající archivní kroky");
    return region;
  }

  function updateLive(entry, record) {
    const region = entry?.querySelector?.(".tool-activity-live");
    if (!region || !record?.activity) return;
    const activity = record.activity;
    let row = region.querySelector(`[data-tool-sequence="${activity.sequence}"]`);
    if (!row) {
      row = document.createElement("li");
      row.dataset.toolSequence = String(activity.sequence);
      region.append(row);
    }
    row.className = `tool-activity-row ${activity.status}`;
    row.textContent = describe(activity);
    region.classList.remove("hidden");
    region.closest(".thinking-card")?.classList.add("has-tool-activity");
  }

  function createSummary(activities) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const list = document.createElement("ol");
    details.className = "tool-activity-summary";
    summary.textContent = `Archivní kroky (${activities.length})`;
    list.className = "tool-activity-list";
    activities.forEach((activity) => {
      const row = document.createElement("li");
      row.className = `tool-activity-row ${activity.status}`;
      row.textContent = describe(activity);
      list.append(row);
    });
    details.append(summary, list);
    return details;
  }

  function describe(activity) {
    const suffix = resultSuffix(activity);
    if (activity.tool_name === "search_archive") {
      const action = activity.status === "running" ? "Hledám v archivu" : "Hledání v archivu";
      return `${action}: ${activity.query || "bez dotazu"}${dateSuffix(activity)}${suffix}`;
    }
    if (activity.tool_name === "read_message_context") {
      const action = activity.status === "running" ? "Načítám okolí" : "Okolí načteno";
      return `${action} ${activity.evidence_id || "?"}: `
        + `${activity.before_count || 0} před / ${activity.after_count || 0} po${suffix}`;
    }
    return `Archivní krok${suffix}`;
  }

  function dateSuffix(activity) {
    if (!activity.date_from && !activity.date_to) return "";
    const from = activity.date_from ? formatDate(activity.date_from) : "začátek archivu";
    const to = activity.date_to ? formatDate(activity.date_to) : "současnost";
    return `, ${from}–${to}`;
  }

  function formatDate(value) {
    const [year, month, day] = String(value).split("-").map(Number);
    return new Intl.DateTimeFormat("cs-CZ", {
      day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC",
    }).format(new Date(Date.UTC(year, month - 1, day)));
  }

  function resultSuffix(activity) {
    if (activity.status === "running") return "";
    if (activity.status === "failed") return ` · chyba ${activity.error_code || "tool_failed"}`;
    if (activity.status === "skipped") return ` · přeskočeno (${activity.error_code || "limit"})`;
    const count = activity.result_message_count;
    const messages = count === null || count === undefined ? "" : ` · ${count} zpráv`;
    const duration = activity.duration_ms === null || activity.duration_ms === undefined
      ? "" : ` · ${activity.duration_ms} ms`;
    return `${messages}${activity.budget_exhausted ? " · vyčerpán limit evidence" : ""}${duration}`;
  }

  return { createLiveRegion, createSummary, updateLive };
})();
