const { BrowserView, session } = require("electron");
const {
  buildDiscordChannelContextScript, buildDiscordExtractionScript,
} = require("./discord-extractor");
const { DiscordChannelScanner } = require("./discord-channel-scanner");
const { secureDiscordView } = require("./window-security");

const HEADER_HEIGHT = 82;
const DISCORD_LEFT_INSET = 392;

function calculateDiscordBounds(width, height) {
  return {
    x: DISCORD_LEFT_INSET,
    y: HEADER_HEIGHT,
    width: Math.max(0, width - DISCORD_LEFT_INSET),
    height: Math.max(0, height - HEADER_HEIGHT),
  };
}

class DiscordViewController {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.discordView = null;
    this.channelScanner = null;
  }

  async open() {
    if (!this.discordView) this.discordView = this.createView();
    this.mainWindow.setBrowserView(this.discordView);
    this.resize();
    const currentUrl = this.discordView.webContents.getURL();
    if (!currentUrl) await this.discordView.webContents.loadURL("https://discord.com/app");
  }

  createView() {
    const persistentSession = session.fromPartition("persist:discord");
    const view = new BrowserView({
      webPreferences: {
        session: persistentSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    secureDiscordView(view.webContents, persistentSession);
    this.channelScanner = new DiscordChannelScanner(view.webContents);
    return view;
  }

  resize() {
    if (!this.discordView) return;
    const [width, height] = this.mainWindow.getContentSize();
    this.discordView.setBounds(calculateDiscordBounds(width, height));
    this.discordView.setAutoResize({ width: true, height: true });
  }

  async captureVisibleMessages() {
    if (!this.discordView) throw new Error("Discord není otevřený.");
    const messages = await this.discordView.webContents.executeJavaScript(
      buildDiscordExtractionScript(),
      true,
    );
    if (!messages.length) throw new Error("V otevřeném chatu nejsou vidět žádné zprávy.");
    return messages;
  }

  startChannelScan(importMessages, reportProgress) {
    if (!this.channelScanner) throw new Error("Discord není otevřený.");
    return this.channelScanner.start(importMessages, reportProgress);
  }

  async getCurrentChannelContext() {
    if (!this.discordView) throw new Error("Discord není otevřený.");
    const context = await this.discordView.webContents.executeJavaScript(
      buildDiscordChannelContextScript(), true,
    );
    if (context.error) throw new Error(context.error);
    return context;
  }

  async jumpToMessage(messageId) {
    const context = await this.getCurrentChannelContext();
    await this.openMessage(context.guildId, context.channelId, messageId);
  }

  async openMessage(guildId, channelId, messageId) {
    if (!/^\d+$/.test(messageId) || !/^\d+$/.test(channelId)) {
      throw new Error("Uložená identita Discord zprávy není platná.");
    }
    if (guildId !== "@me" && !/^\d+$/.test(guildId)) {
      throw new Error("Uložená identita Discord serveru není platná.");
    }
    await this.open();
    const targetUrl = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
    await this.discordView.webContents.loadURL(targetUrl);
  }

  stopChannelScan() {
    this.channelScanner?.stop();
  }

  hide() {
    this.stopChannelScan();
    this.mainWindow.setBrowserView(null);
  }
}

module.exports = { calculateDiscordBounds, DiscordViewController };
