async function consumeNdjsonResponse(response, onRecord) {
  if (!response.body?.getReader) {
    return consumeBufferedNdjson(await response.text(), onRecord);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pendingText = "";
  while (true) {
    const { done, value } = await reader.read();
    pendingText += decoder.decode(value, { stream: !done });
    pendingText = await consumeCompleteLines(pendingText, onRecord);
    if (done) break;
  }
  if (pendingText.trim()) await dispatchLine(pendingText, onRecord);
}

async function consumeCompleteLines(text, onRecord) {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) await dispatchLine(line, onRecord);
  }
  return remainder;
}

async function consumeBufferedNdjson(text, onRecord) {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) await dispatchLine(line, onRecord);
  }
}

async function dispatchLine(line, onRecord) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    throw Object.assign(new Error("Server vrátil neplatný chat stream."), {
      code: "MALFORMED_NDJSON",
    });
  }
  await onRecord(record);
}

module.exports = { consumeNdjsonResponse };
