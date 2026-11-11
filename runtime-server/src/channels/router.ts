import { CHANNEL_LABELS, type ChannelKind } from "./types.js";
import { assertReachable, LINK_CODE_PATTERN, principalFor, type ChannelConnection, type ConnectionRepository, type Linked } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import type { InboxItem } from "./inbox.js";
import type { Handled, Inbound, ReplyPolicy, TargetHandler, TargetKind } from "./ports.js";

export type Notify = (to: { connectionId?: string; channel: ChannelKind; scope: string; address: InboxItem["event"]["address"] }, text: string, replyTo?: string, link?: { label: string; url: string }) => Promise<void>;

/** Port: how a sender the platform vouches for but we do not know signs in to Hatch from their chat. Undefined: not here, or asked too often. */
export type SignIn = (channel: ChannelKind, senderId: string, invite?: string) => Promise<string | undefined>;
/** Port: the owner of a code is the platform identity that sends it: false when that identity already belongs to another account. */
export type Claim = (channel: ChannelKind, scope: string, ownerAccountId: string, senderId: string) => Promise<boolean>;

const SIGN_IN_TEXT = "登录 Hatch，就能在这里和助理聊了。";

/**
 * Decides who sent an event and which Agent answers it. Nobody reaches an Agent without a Connection that knows them:
 * the sender is looked up, never taken from the thread, so a group member cannot act as the person who linked it.
 */
export class ChannelRouter {
  private targets = new Map<TargetKind, TargetHandler>();
  constructor(private deps: { hub: ChannelHub; connections: ConnectionRepository; notify: Notify; signIn?: SignIn; claim?: Claim; onError?: (error: unknown) => void }) {}

  register(kind: TargetKind, handler: TargetHandler): this { this.targets.set(kind, handler); return this; }

  async route(item: InboxItem): Promise<Handled & { connectionId?: string }> {
    const { channel, scope, event } = item;
    const { connections } = this.deps;
    // A scope nobody serves any more is refused: whatever it asked would be answered by another tenant's bot.
    if (!await this.deps.hub.get(channel, scope)) { this.deps.onError?.(new Error(`Refused an inbound ${channel} event for unknown scope "${scope}"`)); return { replied: true }; }
    if (event.unreachable) return { replied: true };
    if (event.revoked) { await connections.revokeTenant(channel, scope); return { replied: true }; }
    const say = (text: string, connectionId?: string, link?: { label: string; url: string }) => this.deps.notify({ ...(connectionId ? { connectionId } : {}), channel, scope, address: event.address }, text, event.messageRef, link);
    /** The sign-in button for a sender we do not know, or false where there is none. */
    const offerSignIn = async (invite?: string): Promise<boolean> => {
      const url = await this.deps.signIn?.(channel, event.address.senderId, invite);
      if (url) await say(SIGN_IN_TEXT, undefined, { label: `用 ${CHANNEL_LABELS[channel]} 登录`, url });
      return Boolean(url);
    };
    // A code binds the sender's private chat; posted in a group it would make the group the Expert's home.
    const code = event.button || event.group ? undefined : event.text?.match(LINK_CODE_PATTERN)?.[0];
    if (code) {
      const peek = await connections.peekCode(channel, scope, code);
      // An invitee is let in only through a sign-in that proves who they are, so the code never admits anyone by itself.
      if (peek?.kind === "guest" && await offerSignIn(code)) return { replied: true };
      if (peek?.kind === "owner" && await this.deps.claim?.(channel, scope, peek.ownerAccountId, event.address.senderId) === false) {
        await say(`这个 ${CHANNEL_LABELS[channel]} 账号已经连着另一个 Hatch 账号。`);
        return { replied: true };
      }
      const linked = peek?.kind === "guest" ? undefined : await connections.redeem(channel, scope, code, event.address);
      if (!linked) { await say(`这个连接码已失效。请回到 Hatch Studio 重新点「连接 ${CHANNEL_LABELS[channel]}」。`); return { replied: true }; }
      await say(await this.greeting(linked), linked.id);
      return { replied: true, connectionId: linked.id };
    }
    const resolved = await connections.resolveConnection({ channel, scope, senderId: event.address.senderId });
    // `public` takes anyone as a contact; every other audience takes only senders that were admitted.
    const identity = resolved?.identity ?? (resolved?.connection.audience === "public" ? await connections.meet(resolved.connection, event.address) : undefined);
    if (!resolved || !identity) {
      // In a group, silence: the bot is not for everyone who can mention it.
      if (!event.group && !await offerSignIn()) await say(`请先从 Hatch Studio 连接 ${CHANNEL_LABELS[channel]}。`);
      return { replied: true };
    }
    const { connection } = resolved;
    assertReachable(connection);
    await connections.touch(connection.id);
    const adapter = (await this.deps.hub.get(channel, scope))!;
    // Best effort, and not awaited: the sender sees that an answer is coming while the Agent works.
    if (!event.button) void adapter.typing?.(event.address, event.messageRef).catch(() => undefined);
    const inbound: Inbound = {
      id: item.id, connection, event, adapter, principal: principalFor(connection, identity), speaker: { role: identity.role, ...(identity.label ? { label: identity.label } : {}) },
      address: { connectionId: connection.id, ...event.address },
      notify: text => say(text, connection.id),
    };
    return { ...await this.handler(connection.target.kind).handle(inbound), connectionId: connection.id };
  }

  /** What the Agent behind a Connection says to someone who has just been bound to it. */
  greeting(linked: Linked): Promise<string> { return this.handler(linked.target.kind).linked(linked, linked.role); }

  /** How the Agent behind a Connection wants the reply of one of its Runs sent. */
  async replyPolicy(connection: ChannelConnection, runId: string): Promise<ReplyPolicy> {
    return await this.targets.get(connection.target.kind)?.replyPolicy?.(connection, runId) ?? {};
  }

  private handler(kind: TargetKind): TargetHandler {
    const handler = this.targets.get(kind);
    if (!handler) throw new Error(`Nothing answers ${kind} Connections yet`);
    return handler;
  }
}
