export type SseFrame = { id?: string; event?: string; data: string };

/** Splits one frame's text into fields; comments (": ...") and frames without data are dropped. */
function parseFrame(block: string): SseFrame | undefined {
  const frame: { id?: string; event?: string; data: string[] } = { data: [] };
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") frame.id = value;
    else if (field === "event") frame.event = value;
    else if (field === "data") frame.data.push(value);
  }
  return frame.data.length ? { id: frame.id, event: frame.event, data: frame.data.join("\n") } : undefined;
}

/** Turns raw bytes of a text/event-stream into frames. A frame cut off by the end of the stream is dropped. */
export async function* sseFrames(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<SseFrame> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const frame = parseFrame(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (frame) yield frame;
    }
  }
}
