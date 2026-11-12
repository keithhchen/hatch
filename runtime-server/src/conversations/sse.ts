import type http from "node:http";
import { MAX_CONSUMER_BUFFERED_BYTES as MAX_BUFFERED_BYTES } from "../chat/sinks.js";

/** Server-Sent Events whose ids are log cursors, so Last-Event-ID resumes exactly. */
export class EventStream {
  constructor(private response: http.ServerResponse) {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(": connected\n\n");
  }
  frame(data: unknown, options: { id?: string; name?: string } = {}): void {
    if (this.response.writableEnded || this.response.destroyed) return;
    this.response.write(`${options.id ? `id: ${options.id}\n` : ""}${options.name ? `event: ${options.name}\n` : ""}data: ${JSON.stringify(data)}\n\n`);
  }
  heartbeat(): void { if (!this.response.writableEnded) this.response.write(": heartbeat\n\n"); }
  get lagging(): boolean { return this.response.writableLength > MAX_BUFFERED_BYTES; }
  end(): void { if (!this.response.writableEnded) this.response.end(); }
}
