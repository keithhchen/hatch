import { HatchError } from "./errors.js";

// Port: bytes (or strings) in, SSE events out: { id?, event, data }.
export async function* parseSse(chunks) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += (typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })).replace(/\r\n/g, "\n");
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = toEvent(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      if (event) yield event;
    }
  }
}

function toEvent(block) {
  const fields = { data: [] };
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const [, name, value] = line.match(/^([^:]*):? ?(.*)$/);
    if (name === "data") fields.data.push(value); else fields[name] = value;
  }
  if (!fields.data.length && !fields.event) return null;
  const raw = fields.data.join("\n");
  let data = raw;
  try { data = JSON.parse(raw); } catch { /* plain text data */ }
  return { id: fields.id, event: fields.event ?? "message", data };
}

// Chat ends a Run with a durable journal `run.state` carrying one of these; the live `turn.state` is not authority.
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const isTerminal = (e) => e.event === "done" || (e.event === "state" && e.data?.status !== "running")
  || (e.event === "journal.event" && e.data?.journal_type === "run.state" && TERMINAL_STATUSES.has(e.data.payload?.status));

// Domain object: folds a Run's events into what a caller needs. The cursor is the last event seen.
export class RunObserver {
  text = "";
  runId;
  cursor;
  status;
  error;

  // Returns the text that is new to the reader.
  apply({ id, event, data }) {
    this.cursor = id ?? this.cursor;
    this.runId = data?.run_id ?? this.runId;
    if (event === "delta") { this.text += data.text; return data.text; }
    if (event === "assistant.delta") {
      if (data.delta?.kind !== "text") return "";
      this.text += data.delta.content;
      return data.delta.content;
    }
    if (event === "journal.event") { if (data.journal_type === "run.state") this.status = data.payload?.status; return ""; }
    if (event === "turn.state") this.status = data.status;
    if (event === "turn.failed") { this.status = "failed"; this.error = data.error; }
    if (event === "message" && data?.role !== "user") {
      const fresh = this.text ? "" : data.text;
      this.text = data.text;
      return fresh;
    }
    if (event === "state") this.status = data.status;
    if (event === "done") this.status = data?.status ?? "idle";
    return "";
  }
}

// Higher-order: given open(after) -> events, return a source that survives dropped connections.
// open(undefined) starts the stream; later calls resume after the last cursor, and an event
// already delivered is skipped. HTTP errors are not retried.
export const resumable = (open, { sleep, retries = 5, backoffMs = 250 }) => async function* (after) {
  const seen = new Set();
  let cursor = after;
  for (let failures = 0; ;) {
    try {
      for await (const event of open(cursor)) {
        if (event.id !== undefined) { if (seen.has(event.id)) continue; seen.add(event.id); cursor = event.id; }
        failures = 0; // only progress counts, so a stream that replays the same events still gives up
        yield event;
        if (isTerminal(event)) return;
      }
    } catch (error) {
      if (error instanceof HatchError && error.code !== "network") throw error;
    }
    if (++failures > retries) {
      throw new HatchError(`Lost the stream${cursor ? ` after cursor ${cursor}` : ""}. The Run keeps going on the server. Resume with --after ${cursor ?? "<cursor>"}.`, { code: "stream_lost" });
    }
    await sleep(backoffMs * failures);
  }
};
