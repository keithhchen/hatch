import { createHash } from "node:crypto";
import type { ChannelAddress, ChannelCapabilities, DeliveryFailure } from "../surfaces/contract.js";

export const CHANNEL_KINDS = ["telegram", "line", "lark", "feishu", "wecom", "wechatkf", "imessage", "slack", "whatsapp", "instagram", "messenger", "discord"] as const;
export type ChannelKind = typeof CHANNEL_KINDS[number];
export const CHANNEL_LABELS: Record<ChannelKind, string> = { telegram: "Telegram", line: "LINE", lark: "Lark", feishu: "飞书", wecom: "企业微信", wechatkf: "微信客服", imessage: "iMessage", slack: "Slack", whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger", discord: "Discord" };
export const isChannelKind = (value: string): value is ChannelKind => (CHANNEL_KINDS as readonly string[]).includes(value);

export type TaskButtonAction = "approve" | "decline";
export type Button = { label: string; taskId: string; action: TaskButtonAction };
/** One message to a platform. Adapters send it as given: the renderer has already made it fit `capabilities()`. */
export type OutboundMessage = { text: string; buttons?: Button[]; replyTo?: string; /** One button that opens a web page, such as a sign-in. */ link?: { label: string; url: string } };

/** Where on a platform: the thread a message lives in, and the person who sent it. Permission follows the sender. */
export type PlatformAddress = Omit<ChannelAddress, "connectionId">;

/** How a platform names a sender: shown to nobody outside Hatch. */
export type SenderProfile = { name?: string; username?: string; language?: string };

export type InboundFile = { ref: string; name: string; size?: number };
/** One thing that happened on a platform, in our terms. No text and no file means a type we can't read yet. */
export type InboundEvent = {
  eventId: string;
  /**
   * Where the platform itself puts this event in its thread's history, when it numbers its events (Telegram's update_id). Events
   * of one thread are handled in this order whatever order they arrived in; without it, in arrival order. A whole number a JSON
   * document carries exactly (below 2^53), so it travels with the stored event.
   */
  sequence?: number;
  address: PlatformAddress;
  /** Who the sender says they are, where the platform tells us with the message. */
  sender?: SenderProfile;
  /** The platform tenant the event belongs to. Absent: the adapter's own scope. A platform whose one endpoint serves many tenants sets it per event. */
  scope?: string;
  /** The platform ended this tenant's access (an uninstall, a revoked token): no message. Its Connections are unbound at once. */
  revoked?: true;
  /** This sender took themselves away from the bot (blocked or removed it): their binding is unbound, with no message. */
  unbound?: true;
  /** The platform refuses any message to this thread (such as another tenant's one-to-one chat): stored, never routed, never answered. */
  unreachable?: true;
  /** A group thread. Group messages reach us only when they address the bot (a mention, or a reply to it). */
  group?: true;
  text?: string;
  file?: InboundFile;
  /** Every file of an album that arrived as several events: the inbox merges them into the first. Read both through `filesOf`. */
  files?: InboundFile[];
  /** The platform's id for a set of messages sent together (a media group). Its events are held until the set is complete, then handled as one. */
  album?: string;
  messageRef?: string;
  button?: { taskId: string; action: TaskButtonAction; ref?: string };
};

export const filesOf = (event: Pick<InboundEvent, "file" | "files">): InboundFile[] => event.files ?? (event.file ? [event.file] : []);

/** The members of an album as one event: the first's address and reference, every file in order, the first caption. */
export function mergeAlbum(first: InboundEvent, rest: InboundEvent[]): InboundEvent {
  if (!rest.length) return first;
  const all = [first, ...rest];
  const text = all.find(event => event.text)?.text;
  const { album: _album, file: _file, ...head } = first;
  return { ...head, ...(text ? { text } : {}), files: all.flatMap(filesOf) };
}

/** What an adapter throws when a send fails, so the outbox can decide what happens next. */
export class ChannelSendError extends Error {
  constructor(message: string, readonly failure: DeliveryFailure, readonly options: { retryAfterMs?: number; access?: boolean } = {}) { super(message); }
}

/** Credentials that ran out and cannot be renewed: the tenant has to install again. */
export class CredentialsExpired extends Error {}

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

/** A platform that only notifies: what to pull. `key` names an independent cursor; `hint` is platform data the pull needs, such as the callback token. */
export type PullNotice = { key: string; hint?: string };

/**
 * Port: one messaging platform. Everything above it knows nothing else about the platform.
 * Webhook platforms implement verify and parse; a platform that pushes over its own connection implements listen.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Empty for our official account; the account id when the Expert brings their own app. */
  readonly scope: string;
  /** What people call this account on the platform (a bot's username), when it has one. */
  readonly handle?: string;
  readonly maxFileBytes: number;
  capabilities(): ChannelCapabilities;
  available(): boolean;
  /** `query` is the URL's query string, where some platforms put the signature. */
  verify?(raw: Buffer, headers: Record<string, string | string[] | undefined>, query?: URLSearchParams): boolean;
  /** respond is the body the platform expects, such as a URL challenge. A platform that only notifies returns `pull` instead of events. */
  parse?(raw: Buffer): { events: InboundEvent[]; respond?: unknown; pull?: PullNotice } | Promise<{ events: InboundEvent[]; respond?: unknown; pull?: PullNotice }>;
  /** After the platform is answered: one full pull from `cursor`, following every page, returning the final cursor. It changes nothing in the adapter, so a failed pull can be repeated. */
  pull?(notice: PullNotice, cursor: string | undefined): Promise<{ events: InboundEvent[]; cursor: string }>;
  /** Answers a GET the platform makes to prove the URL is ours: the plain text to return, or undefined to refuse. */
  challenge?(query: URLSearchParams): string | undefined;
  listen?(onEvents: (events: InboundEvent[]) => Promise<void>, signal: AbortSignal): Promise<void>;
  /** `key` makes a repeated send a no-op on platforms whose capabilities say idempotentSend. A failure throws ChannelSendError. */
  send(to: PlatformAddress, message: OutboundMessage, key: string): Promise<void>;
  download(file: InboundFile): Promise<Buffer>;
  /** Shows the sender that an answer is coming. Best effort: a failure changes nothing. */
  typing?(to: PlatformAddress, messageRef?: string): Promise<void>;
  /** The redirect of the platform's install flow (OAuth): trades its code for the tenant and the credentials to seal for it. */
  install?(code: string): Promise<{ scope: string; credentials: Record<string, unknown> }>;
  /** Credentials that expire: the renewed ones when they are due, undefined when they are not. Throws when they can no longer be renewed. */
  refresh?(credentials: Record<string, unknown>, now: Date): Promise<Record<string, unknown> | undefined>;
  /** Clear a pressed button, where the platform needs that. */
  acknowledge?(event: InboundEvent, text?: string): Promise<void>;
  /** How the Expert reaches us with this code: a link when the platform has one, otherwise the code is enough. */
  connectUrl(code: string): string | undefined;
  /** Opens the chat when no link can carry the code. */
  chatUrl?(): string;
  /** Where a direct message to this user goes, on a platform where that is not the user's own id (a Discord DM is a channel). */
  directThread?(senderId: string): Promise<string>;
}

/** A UUID-shaped, deterministic form of an outbox key, for platforms that take an idempotency key as a UUID. */
export function idempotencyId(key: string): string {
  const hex = createHash("sha256").update(key).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
