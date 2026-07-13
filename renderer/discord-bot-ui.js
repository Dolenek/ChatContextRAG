const discordBotStatus = document.querySelector("#discord-bot-status");
const discordBotToken = document.querySelector("#discord-bot-token");
const inviteDiscordBotButton = document.querySelector("#invite-discord-bot-button");
const disconnectDiscordBotButton = document.querySelector("#disconnect-discord-bot-button");
let discordBotUiHost = null;

async function openDiscordBotSetup() {
  discordBotUiHost.openDrawerPanel("discordBot");
  await refreshDiscordBotStatus();
}

async function refreshDiscordBotStatus() {
  try {
    renderDiscordBotStatus(await window.chatContext.getDiscordBotStatus());
  } catch (error) {
    discordBotUiHost.showToast(error.message, true);
  }
}

async function connectDiscordBot() {
  const token = discordBotToken.value.trim();
  if (!token) return discordBotUiHost.showToast("Vložte Discord bot token.", true);
  setDiscordBotBusy(true);
  try {
    const status = await window.chatContext.connectDiscordBot(token);
    discordBotToken.value = "";
    renderDiscordBotStatus(status);
    discordBotUiHost.showToast("Discord bot je připojený.");
  } catch (error) {
    discordBotUiHost.showToast(error.message, true);
  } finally {
    setDiscordBotBusy(false);
  }
}

async function disconnectDiscordBot() {
  try {
    renderDiscordBotStatus(await window.chatContext.disconnectDiscordBot());
    discordBotUiHost.showToast("Discord bot byl odpojen a token odstraněn.");
  } catch (error) {
    discordBotUiHost.showToast(error.message, true);
  }
}

function renderDiscordBotStatus(status) {
  const error = status.lastError ? ` · chyba: ${status.lastError}` : "";
  discordBotStatus.textContent = status.connected
    ? `${status.botName} · kanály ${status.trackedChannels} · raw ${status.rawMessages || 0} · index ${status.indexedMessages || 0}${error}`
    : `Bot není připojený${error}`;
  inviteDiscordBotButton.disabled = !status.connected;
  disconnectDiscordBotButton.disabled = !status.connected;
}

function setDiscordBotBusy(isBusy) {
  document.querySelector("#connect-discord-bot-button").disabled = isBusy;
  discordBotToken.disabled = isBusy;
}

document.querySelector("#open-discord-bot-button").addEventListener("click", openDiscordBotSetup);
document.querySelector("#connect-discord-bot-button").addEventListener("click", connectDiscordBot);
inviteDiscordBotButton.addEventListener("click", () => window.chatContext.inviteDiscordBot());
disconnectDiscordBotButton.addEventListener("click", disconnectDiscordBot);
window.chatContext.onDiscordBotProgress((progress) => {
  if (progress.type === "error") discordBotUiHost?.showToast(progress.error, true);
  void refreshDiscordBotStatus();
});

window.discordBotUi = {
  bind: (host) => { discordBotUiHost = host; },
};
