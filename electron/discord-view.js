const { BrowserView, session } = require("electron");
const { buildDiscordExtractionScript } = require("./discord-extractor");

const TOOLBAR_HEIGHT = 72;

class DiscordViewController {
  constructor(mainWindow) {
    this.mainWindow = mainWindow;
    this.discordView = null;
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
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://discord.com/")) view.webContents.loadURL(url);
      return { action: "deny" };
    });
    return view;
  }

  resize() {
    if (!this.discordView) return;
    const [width, height] = this.mainWindow.getContentSize();
    this.discordView.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: height - TOOLBAR_HEIGHT });
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

  hide() {
    this.mainWindow.setBrowserView(null);
  }
}

module.exports = { DiscordViewController };
