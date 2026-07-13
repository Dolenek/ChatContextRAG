const { SseClient } = require("../runtime/sse-client");

class RemoteEventForwarder {
  constructor(baseUrl, token, getMainWindow) {
    this.getMainWindow = getMainWindow;
    this.client = new SseClient(
      `${baseUrl}/api/events`,
      { Authorization: `Bearer ${token}` },
      (event) => this.forward(event),
    );
  }

  start() {
    this.client.start();
  }

  stop() {
    this.client.stop();
  }

  forward(event) {
    const channel = {
      indexing: "discord:index:progress",
      "discord-bot": "discord-bot:progress",
    }[event.type];
    if (channel) this.getMainWindow()?.webContents.send(channel, event.payload);
  }
}

module.exports = { RemoteEventForwarder };
