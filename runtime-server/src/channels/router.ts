import { CHANNEL_LABELS, type ChannelKind } from "./types.js";
import { assertReachable, LINK_CODE_PATTERN, principalFor, type ChannelConnection, type ConnectionRepository, type Linked } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import type { InboxItem } from "./inbox.js";
import type { Handled, Inbound, ReplyPolicy, TargetHandler, TargetKind } from "./ports.js";

/** `sourceKey` names the notice for good: saying it again, as a retry of the event does, sends nothing more. */
export type Notify = (to: { connectionId?: string; channel: ChannelKind; scope: string; address: InboxItem["event"]["address"] }, text: string, sourceKey: string, replyTo?: string, link?: { label: string; url: string }) => Promise<void>;

/** Port: how a sender the platform vouches for but we do not know signs in to Hatch from their chat. Undefined: not here, or asked too often. */
export type SignIn = (channel: ChannelKind, senderId: string) => Promise<string | undefined>;
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
    if (event.revoked) { await connections.unbindTenant(channel, scope); return { replied: true }; }
    if (event.unbound) { await connections.unbindSender(channel, scope, event.address.senderId); return { replied: true }; }
    // What the router says to one event is numbered in the order it says it, so a retried event says each thing under the same key.
    let said = 0;
    const say = (text: string, connectionId?: string, link?: { label: string; url: string }) => this.deps.notify({ ...(connectionId ? { connectionId } : {}), channel, scope, address: event.address }, text, `inbox:${item.id}:${said++}`, event.messageRef, link);
    /** The sign-in button for a sender we do not know, or false where there is none. */
    const offerSignIn = async (): Promise<boolean> => {
      const url = await this.deps.signIn?.(channel, event.address.senderId);
      if (url) await say(SIGN_IN_TEXT, undefined, { label: `用 ${CHANNEL_LABELS[channel]} 登录`, url });
      return Boolean(url);
    };
    // A code binds the sender's private chat; posted in a group it would make the group the Expert's home.
    const code = event.button || event.group ? undefined : event.text?.match(LINK_CODE_PATTERN)?.[0];
    if (code) {
      const peek = await connections.peekCode(channel, scope, code);
      if (peek && await this.deps.claim?.(channel, scope, peek.ownerAccountId, event.address.senderId) === false) {
        await say(`这个 ${CHANNEL_LABELS[channel]} 账号已经连着另一个 Hatch 账号。`);
        return { replied: true };
      }
      const linked = await connections.redeem(channel, scope, code, event.address);
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
    const inbound: Inbound = {
      id: item.id, connection, event, adapter, principal: principalFor(connection, identity),
      address: { connectionId: connection.id, ...event.address },
      notify: text => say(text, connection.id),
    };
    return { ...await this.handler(connection.target.kind).handle(inbound), connectionId: connection.id };
  }

  /** What the Agent behind a Connection says to someone who has just been bound to it. */
  greeting(linked: Linked): Promise<string> { return this.handler(linked.target.kind).linked(linked); }

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
