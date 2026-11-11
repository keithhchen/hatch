import WebSocket from "ws";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { buttonId, fitLabel, parseButtonId } from "./buttons.js";
import { listenDiscord, type GatewaySession, type Socket } from "./discordGateway.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";

/** The Expert's own bot. `botId` and `username` are what probe() found out about it: a group message must mention `botId` to reach us. */
export type DiscordCredentials = { token: string; applicationId: string; botId?: string; username?: string };
type Json = Record<string, any>;

const API = "https://discord.com/api/v10";
const MAX_TEXT = 2000;
const MAX_BUTTON_LABEL = 80;
/** A row holds five buttons. */
const ROW = 5;
/** Attachments are served from Discord's own hosts only. */
const CDN = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
/** 403s about this one thread, not about the bot: a closed DM, a channel it may not post in. */
const THREAD_ONLY = new Set([50001, 50007, 50013]);
/** A message and a reply. The rest are system messages: joins, pins. */
const USER_MESSAGE = new Set([0, 19]);
const MESSAGE_COMPONENT = 3;
const UPDATE_MESSAGE = 7;
const ACTION_ROW = 1, BUTTON = 2, SUCCESS = 3, DANGER = 4, LINK = 5;

/** A snowflake is ordered by its time, then its counter; this fits below 2^53 until the 2080s. */
const sequenceOf = (id: string): number => Number((BigInt(id) >> 22n) * 4096n + (BigInt(id) & 0xfffn));

/**
 * Discord, one bot an Expert made. Messages arrive over the Gateway, so `listen` is the only way in. A thread is the channel
 * (a one-to-one chat or a server channel); in a server only a message that mentions the bot or replies to it is ours.
 */
export class DiscordChannel implements ChannelAdapter {
  readonly kind = "discord" as const;
  readonly maxFileBytes = 25 * 1024 * 1024;
  private session: GatewaySession = {};
  constructor(private credentials: DiscordCredentials, readonly scope: string, private fetchImpl: typeof fetch = fetch, private connect: (url: string) => Socket = url => new WebSocket(url)) {}

  get handle(): string | undefined { return this.credentials.username; }
  capabilities(): ChannelCapabilities { return { stream: false, edit: false, typing: true, buttons: true, maxLength: MAX_TEXT, canInitiate: true, idempotentSend: false }; }
  available(): boolean { return Boolean(this.credentials.token && this.credentials.applicationId); }
  /** No link carries a code: the Expert types it in a chat with the bot. */
  connectUrl(_code: string): undefined { return undefined; }
  chatUrl(): string { return `https://discord.com/users/${this.credentials.applicationId}`; }

  /** Proves the token and tells who the bot is. */
  async probe(): Promise<{ botId: string; username: string }> {
    const response = await this.fetchImpl(`${API}/users/@me`, { headers: { authorization: `Bot ${this.credentials.token}` }, signal: AbortSignal.timeout(15_000) });
    const me = await response.json().catch(() => ({})) as Json;
    if (!response.ok || !me.id) throw new Error(`Discord did not accept the bot token: ${me.message ?? response.status}`);
    return { botId: me.id, username: me.username };
  }

  /** A DM is a channel of its own: Discord opens it, or returns the one it already has, for this user. */
  async directThread(senderId: string): Promise<string> {
    const response = await this.fetchImpl(`${API}/users/@me/channels`, {
      method: "POST", headers: { authorization: `Bot ${this.credentials.token}`, "content-type": "application/json" }, body: JSON.stringify({ recipient_id: senderId }), signal: AbortSignal.timeout(15_000),
    });
    const channel = await response.json().catch(() => ({})) as Json;
    if (!response.ok || !channel.id) throw new Error(`Discord did not open a DM with ${senderId}: ${channel.message ?? response.status}`);
    return channel.id;
  }

  listen(onEvents: (events: InboundEvent[]) => Promise<void>, signal: AbortSignal): Promise<void> {
    return listenDiscord({
      token: this.credentials.token, session: this.session, connect: this.connect, signal,
      onDispatch: async (type, data) => {
        const events = type === "MESSAGE_CREATE" ? this.message(data) : type === "INTERACTION_CREATE" ? this.pressed(data) : [];
        if (events.length) await onEvents(events);
      },
    });
  }

  private message(data: Json): InboundEvent[] {
    const { botId } = this.credentials;
    // Bots include ourselves: our own posts come back as events.
    if (!data.author || data.author.bot || !USER_MESSAGE.has(data.type)) return [];
    const group = Boolean(data.guild_id);
    const addressed = Boolean(botId) && ((data.mentions ?? []).some((user: Json) => user.id === botId) || data.referenced_message?.author?.id === botId);
    if (group && !addressed) return [];
    const content = String(data.content ?? "");
    const text = (botId ? content.replaceAll(`<@${botId}>`, "").replaceAll(`<@!${botId}>`, "") : content).trim();
    const files = ((data.attachments ?? []) as Json[]).map(file => ({ ref: file.url as string, name: (file.filename as string) ?? "file", ...(file.size ? { size: file.size as number } : {}) }));
    return [{
      eventId: data.id, sequence: sequenceOf(data.id), address: { threadId: data.channel_id, senderId: data.author.id }, messageRef: data.id,
      ...(group ? { group: true as const } : {}), ...(text ? { text } : {}), ...(files.length ? { files } : {}),
    }];
  }

  private pressed(data: Json): InboundEvent[] {
    const user = data.member?.user ?? data.user;
    if (data.type !== MESSAGE_COMPONENT || data.application_id !== this.credentials.applicationId || !user || !data.channel_id) return [];
    const button = parseButtonId(data.data?.custom_id) ?? { taskId: "", action: "decline" as const };
    return [{
      eventId: data.id, sequence: sequenceOf(data.id), address: { threadId: data.channel_id, senderId: user.id }, ...(data.guild_id ? { group: true as const } : {}),
      ...(data.message?.id ? { messageRef: data.message.id } : {}), button: { ...button, ref: `${data.id}|${data.token}` },
    }];
  }

  async send(to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    const buttons: Json[] = [
      ...(message.buttons ?? []).map(button => ({ type: BUTTON, style: button.action === "approve" ? SUCCESS : DANGER, label: fitLabel(button.label, MAX_BUTTON_LABEL), custom_id: buttonId(button) })),
      ...(message.link ? [{ type: BUTTON, style: LINK, label: fitLabel(message.link.label, MAX_BUTTON_LABEL), url: message.link.url }] : []),
    ];
    const rows = Array.from({ length: Math.ceil(buttons.length / ROW) }, (_, row) => ({ type: ACTION_ROW, components: buttons.slice(row * ROW, row * ROW + ROW) }));
    await this.call(`/channels/${to.threadId}/messages`, "send", {
      content: message.text,
      // Agent output must not ping @everyone or a role.
      allowed_mentions: { parse: [] },
      ...(message.replyTo ? { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } } : {}),
      ...(rows.length ? { components: rows } : {}),
    });
  }

  async typing(to: PlatformAddress): Promise<void> { await this.call(`/channels/${to.threadId}/typing`, "typing"); }

  /** Replaces the pressed message's buttons with the outcome, so a task is not answered twice. */
  async acknowledge(event: InboundEvent, text?: string): Promise<void> {
    const [id, token] = event.button?.ref?.split("|") ?? [];
    if (!id || !token) return;
    await this.call(`/interactions/${id}/${token}/callback`, "acknowledge", { type: UPDATE_MESSAGE, data: { content: text ?? "✓", components: [], allowed_mentions: { parse: [] } } }, false);
  }

  async download(file: InboundFile): Promise<Buffer> {
    const url = new URL(file.ref);
    if (url.protocol !== "https:" || !CDN.has(url.hostname)) throw new Error("Discord attachment is not on Discord's CDN");
    const response = await this.fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Discord attachment download failed: ${response.status}`);
    if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw new Error(`Discord attachment is over ${this.maxFileBytes} bytes`);
    return Buffer.from(await response.arrayBuffer());
  }

  /** `bot` is false for an interaction callback, which its own token authorizes. */
  private async call(path: string, what: string, body?: Json, bot = true): Promise<void> {
    await guardSend(`Discord ${what}`, async () => {
      const response = await this.fetchImpl(`${API}${path}`, {
        method: "POST", headers: { ...(bot ? { authorization: `Bot ${this.credentials.token}` } : {}), "content-type": "application/json" }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return;
      const payload = await response.json().catch(() => ({})) as { code?: number; message?: string; retry_after?: number };
      const failure = failureForStatus(response.status);
      const wait = (payload.retry_after ?? Number(response.headers.get("retry-after"))) * 1000;
      throw new ChannelSendError(`Discord ${what} failed: ${payload.message ?? response.status}`, failure, { access: lostAccess(response.status) && !THREAD_ONLY.has(payload.code ?? 0), ...(failure === "definite" && wait > 0 ? { retryAfterMs: wait } : {}) });
    });
  }
}
