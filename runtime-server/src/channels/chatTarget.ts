import { ChatError } from "../chat/principal.js";
import type { UploadedRef } from "../chat/gateway.js";
import type { ChannelConnection, Role } from "./connections.js";
import type { Handled, Inbound, ReplyPolicy, TargetHandler } from "./ports.js";
import { filesOf } from "./types.js";
import type { ContentPart } from "../surfaces/contract.js";

const DONE: Handled = { replied: true };

/**
 * What one event on a platform means for a conversation, however many platforms and Agents there are. It is the same on every
 * platform and for every Agent: the same event is the same message, so it is keyed by where it came from and what it was.
 */
export const idempotencyKey = ({ connection, event }: Pick<Inbound, "connection" | "event">): string => `${connection.channel}:${connection.scope}:${event.eventId}`;

/**
 * Port: what differs between the Agents a chat can reach (the Assistant, a Product). It knows no platform and no flow:
 * `ChatFlow` owns receiving, deduplicating, downloading, sending and classifying failures once. A new platform is an adapter and
 * changes nothing here; a new kind of Agent is one more ChatTarget.
 */
export interface ChatTarget {
  /** What to say once someone has linked to this Connection, as the owner or as a guest. */
  linked(connection: ChannelConnection, role: Role): Promise<string>;
  /** How the final reply of one of this Agent's Runs is sent. Without it, every Run's reply is sent as it is. */
  replyPolicy?(connection: ChannelConnection, runId: string): Promise<ReplyPolicy>;
  /** Whether this sender may speak here now. Throws when the Connection was never meant for them; a returned text is told to the sender, and nothing starts. */
  admit(inbound: Inbound): Promise<string | undefined>;
  /** What this Agent says to a sender whose file is too big, and whose message it cannot read. */
  wording: { tooLarge(inbound: Inbound): string; unreadable: string };
  /** The text part of a message as this Agent is told it: a guest's words are marked. `attached` says the message also carries files. */
  said?(inbound: Inbound, text: string | undefined, attached: boolean): string | undefined;
  /** Stores a file in the conversation and returns the asset a message refers to. */
  upload(inbound: Inbound, file: { name: string; bytes: Buffer }): Promise<UploadedRef>;
  /** Steers the conversation's Run or starts one. `key` is the message's identity: sending it again is the same message. */
  send(inbound: Inbound, message: { key: string; parts: ContentPart[] }): Promise<{ runId: string }>;
  /** A pressed button. The press is stored before anything is done about it, so a retry never loses or repeats it. Without it, buttons are cleared and ignored. */
  press?(inbound: Inbound, key: string): Promise<Handled>;
}

/** The flow every chat shares. Throwing returns the event to the queue, and only a ChatError that says it is permanent is answered to the sender instead. */
export class ChatFlow implements TargetHandler {
  constructor(private target: ChatTarget) {}

  linked: TargetHandler["linked"] = (connection, role) => this.target.linked(connection, role);

  replyPolicy: NonNullable<TargetHandler["replyPolicy"]> = async (connection, runId) => await this.target.replyPolicy?.(connection, runId) ?? {};

  async handle(inbound: Inbound): Promise<Handled> {
    const { event, adapter } = inbound;
    const target = this.target;
    const key = idempotencyKey(inbound);
    if (event.button) {
      if (target.press) return target.press(inbound, key);
      await adapter.acknowledge?.(event);
      return DONE;
    }
    const refusal = await target.admit(inbound);
    if (refusal) { await inbound.notify(refusal); return DONE; }
    const files = filesOf(event);
    if (files.some(file => (file.size ?? 0) > adapter.maxFileBytes)) { await inbound.notify(target.wording.tooLarge(inbound)); return DONE; }
    const text = event.text?.trim() || undefined;
    const said = target.said ? target.said(inbound, text, files.length > 0) : text;
    const parts: ContentPart[] = said ? [{ type: "text", text: said }] : [];
    try {
      // A failed download or upload throws: the event stays in the inbox and is tried again, also after a restart.
      for (const file of files) {
        const { assetId, kind } = await target.upload(inbound, { name: file.name, bytes: await adapter.download(file) });
        parts.push({ type: kind, assetId });
      }
      if (!parts.length) { await inbound.notify(target.wording.unreadable); return DONE; }
      const { runId } = await target.send(inbound, { key, parts });
      return { replied: false, runId };
    } catch (error) {
      if (!(error instanceof ChatError) || error.retryable) throw error;
      await inbound.notify(error.message);
      return DONE;
    }
  }
}
