let discordBotUiHost = null;

async function openDiscordBotSetup() {
  await discordBotUiHost.openSettings("discord-bot");
}

document.querySelector("#open-discord-bot-button").addEventListener("click", openDiscordBotSetup);
window.chatContext.onDiscordBotProgress((progress) => {
  if (progress.type === "error") discordBotUiHost?.showToast(progress.error, true);
});

window.discordBotUi = {
  bind: (host) => { discordBotUiHost = host; },
};
