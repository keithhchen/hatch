import http from "node:http";
import { createHash } from "node:crypto";
import { until, sleep } from "./util.mjs";

export const bytesSha = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
export const sameBytes = (a, b) => typeof a === "string" && typeof b === "string" && Buffer.from(a, "utf8").equals(Buffer.from(b, "utf8"));
export const median = (values) => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : undefined; };

/** Reads an SSE stream in the background. The stream promise is not awaited by the caller: headers may arrive late. */
export class SseCollector {
  constructor(streamPromise, abort) {
    this.frames = [];
    this.abort = abort;
    this.error = undefined;
    this.ended = false;
    this.opened = streamPromise.then(async (stream) => {
      for await (const frame of stream.frames) { try { frame.json = frame.data === undefined ? undefined : JSON.parse(frame.data); } catch { /* not json */ } this.frames.push(frame); }
      this.ended = true;
    }).catch((error) => { this.error = error; this.ended = true; });
  }
  stop() { this.abort.abort(); }
}

/** A raw HTTP SSE client that reads nothing after the response starts: the slow consumer. Counts what piled up when it finally reads. */
export class StalledSse {
  constructor(base, pathname, headers) {
    this.closed = undefined;
    this.bytesAfterResume = 0;
    this.headersAt = undefined;
    this.opened = new Promise((resolve, reject) => {
      this.request = http.request(new URL(pathname, base), { method: "GET", headers: { accept: "text/event-stream", ...headers } }, (response) => {
        this.response = response; this.headersAt = Date.now();
        response.pause();
        response.on("close", () => { this.closed = { at: Date.now(), complete: response.complete, aborted: response.aborted }; });
        response.on("error", () => { this.closed ??= { at: Date.now() }; });
        resolve(response.statusCode);
      });
      this.request.on("error", (error) => { this.closed ??= { at: Date.now(), error: String(error) }; reject(error); });
      this.request.end();
    });
  }
  /** Starts reading again and returns how many bytes were waiting for it. */
  async drain(ms = 2_000) {
    if (!this.response || this.response.destroyed) return 0;
    this.response.on("data", (chunk) => { this.bytesAfterResume += chunk.length; });
    this.response.resume();
    await sleep(ms);
    return this.bytesAfterResume;
  }
  destroy() { this.response?.destroy(); this.request?.destroy(); }
}

/** Pauses the transport under a client WebSocket: the peer's writes pile up in its buffers and nothing is read. */
export const stall = (socket) => { socket.ws._socket.pause(); };
export const unstall = (socket) => { socket.ws._socket.resume(); };

/** Waits until `probe()` is truthy and returns how long it took, or undefined on timeout. */
export async function timeTo(probe, timeoutMs = 15_000) {
  const started = Date.now();
  try { await until("observer caught up", probe, { timeoutMs, everyMs: 50 }); return Date.now() - started; } catch { return undefined; }
}

/** The cursors must be strictly increasing and equal, as a set and in order, to what the journal holds. */
export function cursorReport(seen, truth) {
  const increasing = seen.every((cursor, index) => index === 0 || cursor > seen[index - 1]);
  const missing = truth.filter((cursor) => !seen.includes(cursor));
  const extra = seen.filter((cursor) => !truth.includes(cursor));
  return { increasing, missing, extra, ok: increasing && !missing.length && !extra.length, count: seen.length };
}

/** Resolves once `count()` has stopped growing for `quietMs`. */
export async function settled(count, quietMs = 1_000, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let last = count(); let since = Date.now();
  while (Date.now() < deadline) {
    await sleep(100);
    const now = count();
    if (now !== last) { last = now; since = Date.now(); } else if (Date.now() - since >= quietMs) return now;
  }
  return count();
}
