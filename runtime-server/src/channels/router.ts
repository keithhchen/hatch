import { CHANNEL_LABELS, type ChannelKind } from "./types.js";
import { assertReachable, LINK_CODE_PATTERN, principalFor, type ConnectionRepository } from "./connections.js";
import type { ChannelHub } from "./hub.js";
import type { InboxItem } from "./inbox.js";
import type { Handled, Inbound, TargetHandler, TargetKind } from "./ports.js";

export type Notify = (to: { connectionId?: string; channel: ChannelKind; scope: string; address: InboxItem["event"]["address"] }, text: string, replyTo?: string) => Promise<void>;

/**
 * Decides who sent an event and which Agent answers it. Nobody reaches an Agent without a Connection that knows them:
 * the sender is looked up, never taken from the thread, so a group member cannot act as the person who linked it.
 */
export class ChannelRouter {
  private targets = new Map<TargetKind, TargetHandler>();
  constructor(private deps: { hub: ChannelHub; connections: ConnectionRepository; notify: Notify }) {}

  register(kind: TargetKind, handler: TargetHandler): this { this.targets.set(kind, handler); return this; }

  async route(item: InboxItem): Promise<Handled & { connectionId?: string }> {
    const { channel, scope, event } = item;
    const { connections } = this.deps;
    if (event.unreachable) return { replied: true };
    if (event.revoked) { await connections.revokeTenant(channel, scope); return { replied: true }; }
    const say = (text: string, connectionId?: string) => this.deps.notify({ ...(connectionId ? { connectionId } : {}), channel, scope, address: event.address }, text, event.messageRef);
    // A code binds the sender's private chat; posted in a group it would make the group the Expert's home.
    const code = event.button || event.group ? undefined : event.text?.match(LINK_CODE_PATTERN)?.[0];
    if (code) {
      const linked = await connections.redeem(channel, scope, code, event.address);
      if (!linked) { await say(`这个连接码已失效。请回到 Hatch Studio 重新点「连接 ${CHANNEL_LABELS[channel]}」。`); return { replied: true }; }
      await say(await this.handler(linked.target.kind).linked(linked), linked.id);
      return { replied: true, connectionId: linked.id };
    }
    const resolved = await connections.resolveConnection({ channel, scope, senderId: event.address.senderId });
    // `public` takes anyone as a contact; every other audience takes only senders that were admitted.
    const identity = resolved?.identity ?? (resolved?.connection.audience === "public" ? await connections.meet(resolved.connection, event.address) : undefined);
    if (!resolved || !identity) {
      // In a group, silence: the bot is not for everyone who can mention it.
      if (!event.group) await say(`请先从 Hatch Studio 连接 ${CHANNEL_LABELS[channel]}。`);
      return { replied: true };
    }
    const { connection } = resolved;
    assertReachable(connection);
    await connections.touch(connection.id);
    const adapter = await this.deps.hub.get(channel, scope);
    if (!adapter) throw new Error(`${channel} is not available`);
    // Best effort, and not awaited: the sender sees that an answer is coming while the Agent works.
    if (!event.button) void adapter.typing?.(event.address, event.messageRef).catch(() => undefined);
    const inbound: Inbound = {
      id: item.id, connection, event, adapter, principal: principalFor(connection, identity),
      address: { connectionId: connection.id, ...event.address },
      notify: text => say(text, connection.id),
    };
    return { ...await this.handler(connection.target.kind).handle(inbound), connectionId: connection.id };
  }

  private handler(kind: TargetKind): TargetHandler {
    const handler = this.targets.get(kind);
    if (!handler) throw new Error(`Nothing answers ${kind} Connections yet`);
    return handler;
  }
}
