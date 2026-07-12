const whatsappOptions = document.querySelector("#whatsapp-options");
const whatsappConversationSelect = document.querySelector("#whatsapp-conversation-select");
const whatsappConversationName = document.querySelector("#whatsapp-conversation-name");
const whatsappDateOrder = document.querySelector("#whatsapp-date-order");
const whatsappImportButton = document.querySelector("#import-whatsapp-button");
const whatsappTextEntry = document.querySelector("#whatsapp-text-entry");
let whatsappUiHost = null;
let selectedWhatsAppFile = null;
let latestWhatsAppPreview = null;

async function openWhatsAppImport() {
  whatsappUiHost.showScreen("whatsapp");
  await loadWhatsAppConversations();
}

async function loadWhatsAppConversations() {
  try {
    const conversations = await window.chatContext.getWhatsAppConversations();
    const options = conversations.map((conversation) =>
      new Option(`${conversation.display_name} · ${conversation.message_count} zpráv`, conversation.conversation_id));
    whatsappConversationSelect.replaceChildren(new Option("Nová konverzace", ""), ...options);
  } catch (error) {
    whatsappUiHost.showToast(error.message, true);
  }
}

async function selectWhatsAppFile() {
  selectedWhatsAppFile = await window.chatContext.selectWhatsAppExport();
  if (!selectedWhatsAppFile) return;
  whatsappTextEntry.replaceChildren();
  whatsappTextEntry.classList.add("hidden");
  document.querySelector("#whatsapp-text-entry-label").classList.add("hidden");
  document.querySelector("#whatsapp-file-name").textContent = selectedWhatsAppFile.fileName;
  whatsappOptions.classList.remove("hidden");
  if (!whatsappConversationName.value) {
    whatsappConversationName.value = selectedWhatsAppFile.fileName.replace(/\.(txt|zip)$/i, "");
  }
  await previewWhatsAppFile();
}

async function previewWhatsAppFile() {
  if (!selectedWhatsAppFile) return;
  whatsappImportButton.disabled = true;
  try {
    latestWhatsAppPreview = await window.chatContext.previewWhatsAppExport({
      date_order: whatsappDateOrder.value || null,
      timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      text_entry: whatsappTextEntry.value || null,
    });
    if (latestWhatsAppPreview.detected_date_order && !whatsappDateOrder.value) {
      whatsappDateOrder.value = latestWhatsAppPreview.detected_date_order;
    }
    renderWhatsAppPreview(latestWhatsAppPreview);
  } catch (error) {
    document.querySelector("#whatsapp-preview-status").textContent = error.message;
    whatsappUiHost.showToast(error.message, true);
  }
}

function renderWhatsAppPreview(preview) {
  if (preview.requires_text_entry) {
    whatsappTextEntry.replaceChildren(
      new Option("Vyberte textový soubor", ""),
      ...preview.available_text_entries.map((entry) => new Option(entry, entry)),
    );
    whatsappTextEntry.classList.remove("hidden");
    document.querySelector("#whatsapp-text-entry-label").classList.remove("hidden");
  }
  const needsDate = preview.requires_date_order && !whatsappDateOrder.value;
  document.querySelector("#whatsapp-preview-status").textContent = preview.requires_text_entry
    ? "ZIP obsahuje více textových souborů. Vyberte jeden."
    : needsDate
    ? `Nalezeno ${preview.message_count} zpráv. Zvolte pořadí data.`
    : `Nalezeno ${preview.message_count} zpráv · média ${preview.media_placeholder_count} · systémové ${preview.system_message_count}`;
  const samples = preview.samples.map((sample) => {
    const item = document.createElement("div");
    item.textContent = `${sample.author}: ${sample.content}`;
    return item;
  });
  document.querySelector("#whatsapp-preview-samples").replaceChildren(...samples);
  updateWhatsAppImportAvailability();
}

function updateWhatsAppImportAvailability() {
  const hasConversation = whatsappConversationSelect.value || whatsappConversationName.value.trim();
  const dateReady = !latestWhatsAppPreview?.requires_date_order || whatsappDateOrder.value;
  const entryReady = !latestWhatsAppPreview?.requires_text_entry || whatsappTextEntry.value;
  whatsappConversationName.disabled = Boolean(whatsappConversationSelect.value);
  whatsappImportButton.disabled = !latestWhatsAppPreview || !hasConversation
    || !dateReady || !entryReady || !latestWhatsAppPreview.message_count;
}

async function importWhatsAppFile() {
  const existingId = whatsappConversationSelect.value;
  const label = existingId
    ? whatsappConversationSelect.selectedOptions[0].textContent.split(" · ")[0]
    : whatsappConversationName.value.trim();
  const conversationId = existingId || crypto.randomUUID();
  whatsappImportButton.disabled = true;
  try {
    const result = await window.chatContext.importWhatsAppExport({
      conversation_id: conversationId, conversation_label: label,
      date_order: whatsappDateOrder.value || null,
      timezone_name: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      text_entry: latestWhatsAppPreview.text_entry || null,
    });
    whatsappUiHost.showToast(
      `WhatsApp: nově uloženo ${result.imported_count}, duplicity ${result.duplicate_count}.`,
    );
    await loadWhatsAppConversations();
  } catch (error) {
    whatsappUiHost.showToast(error.message, true);
  } finally {
    updateWhatsAppImportAvailability();
  }
}

document.querySelector("#open-whatsapp-button").addEventListener("click", openWhatsAppImport);
document.querySelector("#select-whatsapp-file-button").addEventListener("click", selectWhatsAppFile);
whatsappDateOrder.addEventListener("change", previewWhatsAppFile);
whatsappTextEntry.addEventListener("change", previewWhatsAppFile);
whatsappConversationSelect.addEventListener("change", updateWhatsAppImportAvailability);
whatsappConversationName.addEventListener("input", updateWhatsAppImportAvailability);
whatsappImportButton.addEventListener("click", importWhatsAppFile);

window.whatsappImportUi = { bind: (host) => { whatsappUiHost = host; } };
