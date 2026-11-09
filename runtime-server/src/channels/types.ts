import { createHash } from "node:crypto";
import type { ChannelAddress, ChannelCapabilities, DeliveryFailure } from "../surfaces/contract.js";

export const CHANNEL_KINDS = ["telegram", "line", "lark", "feishu", "wecom", "wechatkf", "imessage"] as const;
export type ChannelKind = typeof CHANNEL_KINDS[number];
export const CHANNEL_LABELS: Record<ChannelKind, string> = { telegram: "Telegram", line: "LINE", lark: "Lark", feishu: "飞书", wecom: "企业微信", wechatkf: "微信客服", imessage: "iMessage" };
export const isChannelKind = (value: string): value is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(value);

export type TaskButtonAction = "approve" | "decline";
export type Button = { label: string; taskId: string; action: TaskButtonAction };
/** One message to a platform. Adapters send it as given: the renderer has already made it fit `capabilities()`. */
export type OutboundMessage = { text: string; buttons?: Button[]; replyTo?: string };

/** Where on a platform: the thread a message lives in, and the person who sent it. Permission follows the sender. */
export type PlatformAddress = Omit<ChannelAddress, "connectionId">;

export type InboundFile = { ref: string; name: string; size?: number };
/** One thing that happened on a platform, in our terms. No text and no file means a type we can't read yet. */
export type InboundEvent = {
  eventId: string;
  address: PlatformAddress;
  /** The platform tenant the event belongs to. Absent: the adapter's own scope. A platform whose one endpoint serves many tenants sets it per event. */
  scope?: string;
  /** A group thread. Group messages reach us only when they address the bot (a mention, or a reply to it). */
  group?: true;
  text?: string;
  file?: InboundFile;
  messageRef?: string;
  button?: { taskId: string; action: TaskButtonAction; ref?: string };
};

/** What an adapter throws when a send fails, so the outbox can decide what happens next. */
export class ChannelSendError extends Error {
  constructor(message: string, readonly failure: DeliveryFailure, readonly options: { retryAfterMs?: number; access?: boolean } = {}) { super(message); }
}

/** 429 was refused outright; other 4xx will never work; 5xx and timeouts may have gone through. */
export function failureForStatus(status: number): DeliveryFailure {
  if (status === 429) return "definite";
  return status >= 400 && status < 500 && status !== 408 ? "permanent" : "ambiguous";
}
/** 401 and 403 mean the platform took our access away. */
export const lostAccess = (status: number): boolean => status === 401 || status === 403;

/** Run one request; a thrown fetch error (timeout, reset) may have reached the platform. */
export async function guardSend<T>(what: string, request: () => Promise<T>): Promise<T> {
  try { return await request(); } catch (error) {
    if (error instanceof ChannelSendError) throw error;
    throw new ChannelSendError(`${what} did not complete: ${(error as Error).message}`, "ambiguous");
  }
}

/**
 * Port: one messaging platform. Everything above it knows nothing else about the platform.
 * Webhook platforms implement verify and parse; a platform that pushes over its own connection implements listen.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Empty for our official account; the account id when the Expert brings their own app. */
  readonly scope: string;
  readonly maxFileBytes: number;
  capabilities(): ChannelCapabilities;
  available(): boolean;
  /** `query` is the URL's query string, where some platforms put the signature. */
  verify?(raw: Buffer, headers: Record<string, string | string[] | undefined>, query?: URLSearchParams): boolean;
  /** respond is the body the platform expects, such as a URL challenge. A platform that only notifies pulls its messages here. */
  parse?(raw: Buffer): { events: InboundEvent[]; respond?: unknown } | Promise<{ events: InboundEvent[]; respond?: unknown }>;
  /** Answers a GET the platform makes to prove the URL is ours: the plain text to return, or undefined to refuse. */
  challenge?(query: URLSearchParams): string | undefined;
  listen?(onEvents: (events: InboundEvent[]) => Promise<void>, signal: AbortSignal): Promise<void>;
  /** `key` makes a repeated send a no-op on platforms whose capabilities say idempotentSend. A failure throws ChannelSendError. */
  send(to: PlatformAddress, message: OutboundMessage, key: string): Promise<void>;
  download(file: InboundFile): Promise<Buffer>;
  /** Clear a pressed button, where the platform needs that. */
  acknowledge?(event: InboundEvent, text?: string): Promise<void>;
  /** How the Expert reaches us with this code: a link when the platform has one, otherwise the code is enough. */
  connectUrl(code: string): string | undefined;
  /** Opens the chat when no link can carry the code. */
  chatUrl?(): string;
}

/** A UUID-shaped, deterministic form of an outbox key, for platforms that take an idempotency key as a UUID. */
export function idempotencyId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
