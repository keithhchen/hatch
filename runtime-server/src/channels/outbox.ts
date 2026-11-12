import type { DeliveryState } from "../surfaces/contract.js";
import type { ChannelKind, OutboundMessage, PlatformAddress } from "./types.js";

export type DeliveryKind = "reply" | "notice";

/** One reply or notice to one thread, as one or more messages that go in order. */
export type Delivery = {
  id: string;
  connectionId?: string;
  channel: ChannelKind;
  scope: string;
  address: PlatformAddress;
  kind: DeliveryKind;
  parts: OutboundMessage[];
  /** How many parts the platform has accepted. */
  sentParts: number;
  state: DeliveryState;
  attempts: number;
  /** Which claim holds the lease: every claim adds one, so a worker whose lease ran out and was claimed by another cannot write. */
  claims: number;
  /** A part was being sent when the lease ran out: the platform may have it. */
  inFlight: boolean;
};

export type NewDelivery = Pick<Delivery, "channel" | "scope" | "address" | "kind" | "parts"> & {
  connectionId?: string;
  state: Extract<DeliveryState, "pending" | "undelivered">;
  /** At most one delivery exists per key: the database refuses a second. */
  sourceKey?: string;
};

/** What a worker holds after `claim`: the delivery and the claim that leased it. */
export type Lease = Pick<Delivery, "id" | "claims">;

/** Port: every message we owe a platform, kept until the platform has it or we know it cannot. */
export interface Outbox {
  /** Undefined when a delivery with this source key already exists. */
  enqueue(input: NewDelivery): Promise<Delivery | undefined>;
  /** Leases the next due delivery of each thread. A thread's deliveries go out in the order they were queued. */
  claim(limit: number, leaseMs: number, now?: Date): Promise<Delivery[]>;
  /**
   * Every write below applies only while the lease is held: the delivery is `sending`, this claim holds it, and it has not expired.
   * It returns whether it applied; when it did not, another worker owns the delivery and the caller stops.
   */
  /** About to send part `sentParts`; if the process dies now, the delivery is `inFlight` when next claimed. */
  begin(lease: Lease, now?: Date): Promise<boolean>;
  progress(lease: Lease, sentParts: number, leaseMs: number, now?: Date): Promise<boolean>;
  settle(lease: Lease, state: DeliveryState, error?: string, now?: Date): Promise<boolean>;
  /** Back to `pending` after `delayMs`, or `failed` once `maxAttempts` is reached. Undefined when the lease is not held. */
  retry(lease: Lease, error: string, delayMs: number, maxAttempts: number, now?: Date): Promise<DeliveryState | undefined>;
  /** Not yet: the rate limit said wait. This is not a failed attempt. */
  defer(lease: Lease, delayMs: number, now?: Date): Promise<boolean>;
  /** Parts the platform accepted for this thread since `since`: what a reply allowance counts. */
  sentSince(channel: ChannelKind, scope: string, threadId: string, since: Date): Promise<number>;
  undelivered(connectionId: string): Promise<Delivery[]>;
  get(id: string): Promise<Delivery | undefined>;
}
