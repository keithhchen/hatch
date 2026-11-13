import type { ChannelKind, InboundEvent } from "./types.js";

export type InboxItem = {
  id: string;
  channel: ChannelKind;
  scope: string;
  event: InboundEvent;
  attempts: number;
  connectionId?: string;
  runId?: string;
};

/** Who holds an event: the claim that leased it. `attempts` counts claims, so an older claim never matches a newer one. */
export type Lease = Pick<InboxItem, "id" | "attempts">;

/** The photos of an album arrive as separate events; the first is handled once no new one has come for this long. */
export const ALBUM_SETTLE_MS = 1500;

/** A thread with a message nobody has answered yet. */
export type WaitingThread = { connectionId: string; channel: ChannelKind; scope: string; threadId: string; senderId: string };

/**
 * Port: every verified inbound event, stored before the platform is answered.
 * Processing is a lease, so a crash returns the event to the queue.
 */
export interface Inbox {
  /** The events not stored before. A repeat is refused by the database, whatever its timing. */
  store(channel: ChannelKind, scope: string, events: InboundEvent[], now?: Date, after?: { key: string; cursor: string }): Promise<InboxItem[]>;
  /**
   * Where a pull stopped, kept in one transaction with the events it fetched. It belongs to the platform tenant (scope) and
   * the notice's key, not to a Connection: several Connections share a tenant, so none of them can name it.
   */
  cursor(channel: ChannelKind, scope: string, key: string): Promise<string | undefined>;
  /** Leases the next unprocessed event of each thread. Events of one thread are handed out one at a time, in the platform's sequence when events carry one (`InboundEvent.sequence`) and in arrival order otherwise; an album's first waits until its album is complete. */
  claim(limit: number, leaseMs: number, now?: Date): Promise<InboxItem[]>;
  /** The other events of this event's album that are still waiting, in the thread's order. */
  siblings(item: InboxItem): Promise<InboxItem[]>;
  /**
   * Every write below belongs to the claim that holds the lease and to it alone: once the lease has run out, or another worker has
   * claimed the event, the write changes nothing and says so (false or undefined), so a slow worker cannot undo a faster one.
   */
  /** The claimant is alive: pushes its lease out, so a dead one is noticed after a short lease however long processing takes. */
  extend(lease: Lease, leaseMs: number, now?: Date): Promise<boolean>;
  /** Marks the event done, together with the `absorbed` events that were handled as part of it (the rest of an album). */
  complete(lease: Lease, outcome: { connectionId?: string; runId?: string; replied?: boolean }, absorbed?: string[], now?: Date): Promise<boolean>;
  /** Releases the lease after `delayMs`; after `maxAttempts` the event is given up and kept as failed. */
  retry(lease: Lease, error: string, delayMs: number, maxAttempts: number, now?: Date): Promise<"pending" | "failed" | undefined>;
  get(id: string): Promise<InboxItem | undefined>;
  /** How many messages people have sent to a platform tenant: every stored event but the system ones (a button press, a block, an uninstall). Counted on the tenant, so it follows the bot. */
  inboundCount(channel: ChannelKind, scope: string): Promise<number>;
  /** When the platform last wrote to this thread. */
  lastInbound(channel: ChannelKind, scope: string, threadId: string): Promise<Date | undefined>;
  /** These events have been answered, and nothing else has. */
  markReplied(ids: string[]): Promise<void>;
  waiting(filter: { runId: string }, now?: Date): Promise<WaitingThread[]>;
  byRun(runId: string): Promise<InboxItem[]>;
  /** Runs started for a message nobody has answered yet, oldest first. */
  openRuns(limit: number): Promise<string[]>;
}
