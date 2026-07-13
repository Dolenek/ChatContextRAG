class SseClient {
  constructor(url, headers, onMessage) {
    this.url = url;
    this.headers = headers;
    this.onMessage = onMessage;
    this.abortController = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.connectLoop();
  }

  stop() {
    this.running = false;
    this.abortController?.abort();
  }

  async connectLoop() {
    while (this.running) {
      try {
        await this.consumeConnection();
      } catch (error) {
        if (this.running && error.name !== "AbortError") {
          await delay(2000);
        }
      }
    }
  }

  async consumeConnection() {
    this.abortController = new AbortController();
    const response = await fetch(this.url, {
      headers: this.headers,
      signal: this.abortController.signal,
    });
    if (!response.ok) throw new Error(`Event stream returned ${response.status}.`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (this.running) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      buffer = this.consumeFrames(buffer);
    }
  }

  consumeFrames(buffer) {
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame.split("\n").filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6)).join("\n");
      if (data) this.onMessage(JSON.parse(data));
    }
    return buffer;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

module.exports = { SseClient };
