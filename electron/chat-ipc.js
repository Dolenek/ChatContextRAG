class ChatIpcController {
  constructor(ipcMain, getBackendClient) {
    this.ipcMain = ipcMain;
    this.getBackendClient = getBackendClient;
  }

  register() {
    this.ipcMain.handle("database:ask-stream", (event, input) => (
      this.streamAnswer(event, input)
    ));
  }

  async streamAnswer(event, input) {
    let finalResponse = null;
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    event.sender.once?.("destroyed", abort);
    try {
      await this.getBackendClient().streamNdjson(
        "/chat/stream", input.request,
        (record) => {
          if (record.type === "final") finalResponse = record.response;
          else if (record.type === "error") throw streamError(record);
          else this.forwardActivity(event, input.requestId, record);
        },
        { timeoutMs: 130_000, signal: cancellation.signal },
      );
    } finally {
      event.sender.removeListener?.("destroyed", abort);
    }
    if (!finalResponse) throw streamError({
      code: "missing_final", detail: "Chat stream skončil bez finální odpovědi.",
    });
    return finalResponse;
  }

  forwardActivity(event, requestId, record) {
    if (event.sender.isDestroyed()) return;
    event.sender.send("database:chat-progress", { requestId, record });
  }
}

function streamError(record) {
  return Object.assign(new Error(record.detail || "Adaptivní chat selhal."), {
    code: record.code || "CHAT_STREAM_ERROR",
  });
}

module.exports = { ChatIpcController };
