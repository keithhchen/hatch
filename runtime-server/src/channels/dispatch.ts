import { deliveryAfterFailure, type ChannelCapabilities } from "../surfaces/contract.js";
import type { ConnectionRepository } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import type { Inbox } from "./inbox.js";
import { backoffMs } from "./loop.js";
import type { Delivery, DeliveryKind, Outbox } from "./outbox.js";
import type { Rate, RateLimiter } from "./rateLimiter.js";
import { render } from "./render.js";
import { ChannelSendError, type ChannelKind, type OutboundMessage, type PlatformAddress } from "./types.js";

const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 5;
const DEFAULT_RATES = { chat: { capacity: 3, perSecond: 1 }, connection: { capacity: 30, perSecond: 30 } };

/** A reply is allowed while the platform's window after the last inbound message is open. */
export function replyWindowOpen(capabilities: Pick<ChannelCapabilities, "replyWindowMs">, lastInbound: Date | undefined, now: Date): boolean {
  return capabilities.replyWindowMs === undefined || (lastInbound !== undefined && now.getTime() - lastInbound.getTime() <= capabilities.replyWindowMs);
}

export type Send = { connectionId?: string; channel: ChannelKind; scope: string; address: PlatformAddress; kind: DeliveryKind; message: OutboundMessage; sourceKey?: string };

/**
 * Turns messages into durable deliveries and sends them. A delivery's fate follows deliveryAfterFailure: it is retried only
 * when that cannot send twice, and is otherwise failed or left `unknown`. It never changes what was said.
 */
export class Dispatcher {
  constructor(private deps: {
    outbox: Outbox; hub: ChannelHub; limiter: RateLimiter; connections: Pick<ConnectionRepository, "setState" | "unbindPersonal">; inbox: Pick<Inbox, "lastInbound">;
    now?: () => Date; rates?: { chat: Rate; connection: Rate }; maxAttempts?: number; onQueued?: () => void; onError?: (error: unknown) => void;
  }) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }

  /** Whether a message to this thread could go out now, for work that would be wasted otherwise. */
  async open(channel: ChannelKind, scope: string, threadId: string): Promise<boolean> {
    const adapter = await this.deps.hub.get(channel, scope);
    return adapter ? replyWindowOpen(adapter.capabilities(), await this.deps.inbox.lastInbound(channel, scope, threadId), this.now()) : false;
  }

  /** Queues the message rendered for its platform. Outside the reply window it is kept in Hatch as `undelivered`. */
  async send(input: Send): Promise<Delivery | undefined> {
    const adapter = await this.deps.hub.get(input.channel, input.scope);
    if (!adapter) throw new Error(`${input.channel} is not available`);
    const capabilities = adapter.capabilities();
    const open = replyWindowOpen(capabilities, await this.deps.inbox.lastInbound(input.channel, input.scope, input.address.threadId), this.now());
    const queued = await this.deps.outbox.enqueue({ ...input, parts: render(input.message, capabilities), state: open ? "pending" : "undelivered" });
    if (queued?.state === "pending") this.deps.onQueued?.();
    return queued;
  }

  /** Sends what is due. Returns how many deliveries it handled. */
  async step(): Promise<number> {
    const claimed = await this.deps.outbox.claim(10, LEASE_MS, this.now());
    await Promise.all(claimed.map(delivery => this.deliver(delivery).catch(error => this.retry(delivery, (error as Error).message))));
    return claimed.length;
  }

  private async deliver(delivery: Delivery): Promise<void> {
    const { outbox } = this.deps;
    const adapter = await this.deps.hub.get(delivery.channel, delivery.scope);
    if (!adapter) {
      // Nothing may send this: its tenant is gone, and no other tenant's bot speaks for it.
      const reason = `No ${delivery.channel} adapter for scope "${delivery.scope}"`;
      this.deps.onError?.(new Error(`${reason}: delivery ${delivery.id} failed`));
      return outbox.settle(delivery.id, "failed", reason);
    }
    const capabilities = adapter.capabilities();
    // The lease ran out in the middle of a send: the platform may already have it.
    if (delivery.inFlight && deliveryAfterFailure({ failure: "ambiguous", idempotent: capabilities.idempotentSend }) === "unknown") return outbox.settle(delivery.id, "unknown", "Lease expired while sending");
    const lastInbound = await this.deps.inbox.lastInbound(delivery.channel, delivery.scope, delivery.address.threadId);
    if (!replyWindowOpen(capabilities, lastInbound, this.now())) return outbox.settle(delivery.id, "undelivered");
    // The allowance restarts with each inbound message. Parts this delivery already sent are in the count.
    let allowed = capabilities.replyAllowance === undefined ? Infinity
      : capabilities.replyAllowance - (lastInbound ? await outbox.sentSince(delivery.channel, delivery.scope, delivery.address.threadId, lastInbound) : 0);
    for (let index = delivery.sentParts; index < delivery.parts.length; index += 1) {
      if (allowed-- < 1) return outbox.settle(delivery.id, "undelivered", "Reply allowance spent");
      const wait = await this.throttle(delivery);
      if (wait > 0) return outbox.defer(delivery.id, wait, this.now());
      await outbox.begin(delivery.id);
      try { await adapter.send(delivery.address, delivery.parts[index]!, `${delivery.id}:${index}`); } catch (error) { return this.fail(delivery, capabilities, error); }
      await outbox.progress(delivery.id, index + 1, LEASE_MS, this.now());
    }
    await outbox.settle(delivery.id, "sent");
    if (delivery.connectionId) await this.deps.connections.setState(delivery.connectionId, "active");
  }

  /** Per chat first, then for the whole Connection. Milliseconds to wait, or zero. */
  private async throttle(delivery: Delivery): Promise<number> {
    const rates = this.deps.rates ?? DEFAULT_RATES;
    const chat = await this.deps.limiter.take(`chat:${delivery.channel}:${delivery.scope}:${delivery.address.threadId}`, rates.chat, this.now());
    return chat || this.deps.limiter.take(`connection:${delivery.connectionId ?? `${delivery.channel}:${delivery.scope}`}`, rates.connection, this.now());
  }

  /** Something other than the platform went wrong before a send: try again, a bounded number of times. */
  private async retry(delivery: Delivery, message: string, delayMs = backoffMs(delivery.attempts + 1)): Promise<void> {
    await this.deps.outbox.retry(delivery.id, message, delayMs, this.deps.maxAttempts ?? MAX_ATTEMPTS, this.now());
  }

  private async fail(delivery: Delivery, capabilities: ChannelCapabilities, error: unknown): Promise<void> {
    const sendError = error instanceof ChannelSendError ? error : new ChannelSendError((error as Error).message, "ambiguous");
    const next = deliveryAfterFailure({ failure: sendError.failure, idempotent: capabilities.idempotentSend });
    if (next === "pending") await this.retry(delivery, sendError.message, sendError.options.retryAfterMs);
    else await this.deps.outbox.settle(delivery.id, next, sendError.message);
    // A person's own binding that the platform refuses has been unbound from their side, and is gone. A Connection that serves others, or an Expert's own bot, is only degraded: one contact blocking it is not the token failing.
    if (sendError.options.access && delivery.connectionId && !await this.deps.connections.unbindPersonal(delivery.connectionId)) await this.deps.connections.setState(delivery.connectionId, "degraded");
  }
}
