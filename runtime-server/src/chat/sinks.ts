import type http from "node:http";
import { WebSocket } from "ws";
import type { EventSink } from "./runEventHub.js";

/** A consumer with this much unsent is disconnected whatever the largest payload is; it reconnects by cursor. */
export const MAX_CONSUMER_BUFFERED_BYTES = 1024 * 1024;

/** A consumer that falls this far behind is disconnected; it reconnects by cursor. */
export class SlowConsumerError extends Error {
  constructor() {
    super("The consumer is too slow");
    this.name = "SlowConsumerError";
  }
}

/** Writes events to a WebSocket without waiting for the peer. */
export class SocketSink implements EventSink {
  constructor(
    private readonly socket: WebSocket,
    private readonly project: (event: Record<string, unknown>) => Record<string, unknown> = (event) => event
  ) {}

  push(event: Record<string, unknown>): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(this.project(event));
    if (this.socket.bufferedAmount > MAX_CONSUMER_BUFFERED_BYTES) {
      this.socket.terminate();
      throw new SlowConsumerError();
    }
    this.socket.send(payload);
  }
}

/** Writes events to a Server-Sent Events response; `id` is the cursor, so Last-Event-ID resumes. */
export class SseSink implements EventSink {
  constructor(private readonly response: http.ServerResponse) {}

  push(event: Record<string, unknown>): void {
    if (this.response.writableEnded || this.response.destroyed) throw new SlowConsumerError();
    if (this.response.writableLength > MAX_CONSUMER_BUFFERED_BYTES) {
      this.response.destroy();
      throw new SlowConsumerError();
    }
    this.response.write(`${typeof event.cursor === "number" ? `id: ${event.cursor}\n` : ""}event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}
