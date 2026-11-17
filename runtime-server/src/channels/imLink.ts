import { createHmac, timingSafeEqual } from "node:crypto";
import { ChatError } from "../chat/principal.js";
import type { ChannelKind } from "./types.js";
import { GLOBAL_USER_ID_CHANNELS, type ChannelConnection, type ConnectionRepository } from "./connections.js";

const TTL_MS = 30 * 60_000;

/**
 * The link an IM contact follows to sign in on the web. It is signed (HMAC-SHA256, `payload.signature`, both base64url),
 * expires after 30 minutes, and names the contact it was issued to. Claiming it links the person behind the contact to the
 * account that claims: once linked, the same link claimed by another account is refused.
 */
export class ImLinks {
  private readonly key: Buffer;
  constructor(private readonly deps: { secret: string; origin: string; connections: Pick<ConnectionRepository, "contact" | "linkAccount">; now?: () => Date }) {
    if (!deps.secret.trim()) throw new Error("IM links need a signing secret");
    this.key = createHmac("sha256", deps.secret).update("hatch-im-link-v1").digest();
  }

  /** Only a platform whose sender id is a person Hatch can recognise can be linked. */
  linkable(connection: Pick<ChannelConnection, "channel">): boolean { return GLOBAL_USER_ID_CHANNELS.has(connection.channel as ChannelKind); }

  url(connectionId: string, contactId: string): string {
    const payload = Buffer.from(JSON.stringify({ connectionId, contactId, exp: this.now() + TTL_MS })).toString("base64url");
    return `${this.deps.origin}/link/im?t=${payload}.${this.sign(payload)}`;
  }

  /** Links the contact's person to `accountId`. The same account again is the same result. */
  async claim(token: string, accountId: string): Promise<{ productId: string; connectionId: string; channel: string }> {
    const { connectionId, contactId } = this.open(token);
    const { connection, identity } = await this.deps.connections.contact(contactId) ?? {};
    if (!connection || !identity || connection.id !== connectionId || !this.linkable(connection) || connection.target.kind !== "product") throw new ChatError("im_link_invalid", "This link is not valid.", 400);
    if (!await this.deps.connections.linkAccount(connection.channel as ChannelKind, identity.senderId, accountId)) throw new ChatError("im_already_linked", "This chat is already linked to another account.", 409);
    return { productId: connection.target.productId, connectionId: connection.id, channel: connection.channel };
  }

  private open(token: string): { connectionId: string; contactId: string } {
    const [payload = "", signature = ""] = token.split(".");
    const expected = Buffer.from(this.sign(payload));
    const supplied = Buffer.from(signature);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new ChatError("im_link_invalid", "This link is not valid.", 400);
    const body = JSON.parse(Buffer.from(payload, "base64url").toString()) as { connectionId: string; contactId: string; exp: number };
    if (body.exp <= this.now()) throw new ChatError("im_link_expired", "This link has expired.", 410);
    return body;
  }

  private sign(payload: string): string { return createHmac("sha256", this.key).update(payload).digest("base64url"); }
  private now(): number { return (this.deps.now?.() ?? new Date()).getTime(); }
}
