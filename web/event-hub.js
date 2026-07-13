class EventHub {
  constructor() {
    this.clients = new Set();
    this.heartbeat = setInterval(() => this.sendRaw(": heartbeat\n\n"), 20000);
    this.heartbeat.unref?.();
  }

  connect(request, response) {
    response.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    });
    response.write(": connected\n\n");
    this.clients.add(response);
    request.on("close", () => this.clients.delete(response));
  }

  publish(type, payload) {
    this.sendRaw(`data: ${JSON.stringify({ type, payload })}\n\n`);
  }

  sendRaw(message) {
    for (const response of this.clients) response.write(message);
  }

  close() {
    clearInterval(this.heartbeat);
    for (const response of this.clients) response.end();
    this.clients.clear();
  }
}

module.exports = { EventHub };
