import type http from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { MAX_CONSUMER_BUFFERED_BYTES as MAX_BUFFERED_BYTES } from "../chat/sinks.js";
import { ConversationError } from "./conversation.js";
import { follow, resumePoint, withoutPartials } from "./follow.js";
import { snapshotOf } from "./snapshot.js";
import type { Studio, TargetSpec } from "./studio.js";

export const STUDIO_SOCKET_PATH = "/v1/creator/studio/ws";
const AUTH_TIMEOUT_MS = 10_000;

export type Identity = { accountId: string; token: string };

export type SocketDeps = {
  studio: Studio;
  /** The account a token belongs to; nothing for a token that is not valid. */
  identify(token: string): Promise<Identity | undefined>;
  pollMs?: number;
};

type Subscribe = { type: "subscribe"; id: string; target: { product_id?: string; worker?: string; assistant?: boolean }; after?: string; stream: boolean };
type Incoming = { type: "auth"; token: string } | Subscribe | { type: "unsubscribe"; id: string } | { type: "ping" };

const specOf = (target: Subscribe["target"]): TargetSpec => {
  if (target?.assistant) return { kind: "assistant" };
  if (target?.product_id && target.worker) return { kind: "worker", productId: target.product_id, workerId: target.worker };
  throw new ConversationError(400, "invalid_target", "target is { assistant: true } or { product_id, worker }.");
};

/**
 * Studio over WebSocket: subscribe to any number of conversations on one socket.
 * `stream: true` delivers every event; `stream: false` delivers results without token-level partials.
 * The browser path authenticates at upgrade (the origin check happens where the cookie is read);
 * API keys are sent as the first message and never travel in a URL.
 */
export class StudioSockets {
  private server = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  constructor(private deps: SocketDeps) {}

  /** `identity` is what the upgrade already proved; without it the first message must be `auth`. */
  upgrade(request: http.IncomingMessage, socket: Duplex, head: Buffer, identity?: Identity): void {
    this.server.handleUpgrade(request, socket, head, ws => this.connection(ws, identity));
  }

  private connection(ws: WebSocket, initial?: Identity): void {
    let identity = initial;
    const subscriptions = new Map<string, AbortController>();
    const send = (value: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(value));
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) ws.close(1013, "slow consumer: resume from your last cursor");
    };
    const fail = (id: string | undefined, error: unknown) => {
      const known = error instanceof ConversationError ? error : new ConversationError(500, "internal_error", "Request failed.");
      send({ type: "error", ...(id ? { id } : {}), error: { code: known.code, message: known.message } });
    };
    const authTimer = identity ? undefined : setTimeout(() => ws.close(4401, "authentication required"), AUTH_TIMEOUT_MS);
    if (identity) send({ type: "ready" });
    const subscribe = async (message: Subscribe) => {
      if (!message.id || typeof message.stream !== "boolean") throw new ConversationError(400, "invalid_subscribe", "subscribe needs an id and stream: true or false.");
      subscriptions.get(message.id)?.abort();
      const { conversation } = await this.deps.studio.target(identity!.accountId, identity!.token, specOf(message.target));
      const log = this.deps.studio.eventLog;
      const feed = await conversation.feedKey();
      if (!feed) { send({ type: "snapshot", id: message.id, snapshot: await snapshotOf(conversation, log) }); return; }
      let from = message.after === undefined ? undefined : await resumePoint(log, feed, message.after);
      if (from === undefined) { const snapshot = await snapshotOf(conversation, log); from = snapshot.cursor; send({ type: "snapshot", id: message.id, snapshot }); }
      const stop = new AbortController();
      subscriptions.set(message.id, stop);
      const deliver = ({ cursor, event }: { cursor: string; event: unknown }) => send({ type: "event", id: message.id, cursor, event });
      void follow(log, feed, from, message.stream ? deliver : withoutPartials(deliver), { signal: stop.signal, pollMs: this.deps.pollMs }).catch(error => fail(message.id, error));
    };
    ws.on("message", data => {
      void (async () => {
        let message: Incoming;
        try { message = JSON.parse(data.toString()); } catch { return fail(undefined, new ConversationError(400, "invalid_json", "Messages are JSON.")); }
        if (message.type === "auth") {
          if (identity) return fail(undefined, new ConversationError(400, "already_authenticated", "This socket is already authenticated."));
          identity = await this.deps.identify(String(message.token ?? ""));
          if (!identity) { send({ type: "error", error: { code: "unauthorized", message: "A valid token is required." } }); ws.close(4401, "unauthorized"); return; }
          clearTimeout(authTimer);
          return send({ type: "ready" });
        }
        if (!identity) { ws.close(4401, "authentication required"); return; }
        if (message.type === "ping") return send({ type: "pong" });
        if (message.type === "unsubscribe") { subscriptions.get(message.id)?.abort(); subscriptions.delete(message.id); return; }
        if (message.type === "subscribe") return subscribe(message).catch(error => fail(message.id, error));
        fail(undefined, new ConversationError(400, "unknown_message", "Unknown message type."));
      })().catch(error => fail(undefined, error));
    });
    // Closing a client never touches a Run: it only stops these readers.
    ws.on("close", () => { clearTimeout(authTimer); for (const stop of subscriptions.values()) stop.abort(); });
    ws.on("error", () => undefined);
  }
}
