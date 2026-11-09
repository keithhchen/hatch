import { createHmac, timingSafeEqual } from "node:crypto";
import type { ChannelCapabilities } from "../surfaces/contract.js";
import { buttonId, fitLabel, parseButtonId } from "./buttons.js";
import type { TenantTokens } from "./tenantTokens.js";
import { ChannelSendError, failureForStatus, guardSend, lostAccess, type ChannelAdapter, type InboundEvent, type InboundFile, type OutboundMessage, type PlatformAddress } from "./types.js";

export type SlackConfig = { signingSecret?: string; clientId?: string; clientSecret?: string; redirectUri?: string; tokens?: TenantTokens; now?: () => number };
type Json = Record<string, any>;

const API = "https://slack.com/api";
/** Slack rejects a request signed more than five minutes ago, which is what stops a replay. */
const REPLAY_MS = 5 * 60_000;
const SCOPES = "app_mentions:read,chat:write,im:history,files:read";
/** A section holds 3000 characters, and a reply with buttons is a section. */
const MAX_TEXT = 3000;
const MAX_BUTTON_LABEL = 75;
/** The token or its scopes are gone: nothing we send will work until the workspace installs again. */
const ACCESS_LOST = new Set(["token_revoked", "account_inactive", "invalid_auth", "not_authed", "token_expired", "missing_scope"]);
/** Slack's own trouble: the message may have been posted. */
const TRANSIENT = new Set(["internal_error", "fatal_error", "service_unavailable", "request_timeout"]);
const MENTION = /^\s*<@[A-Z0-9]+>\s*/;

/**
 * Slack, installed per workspace by OAuth. Events API with a signing secret; the workspace is the tenant. A thread is
 * `team:channel[:thread_ts]`, so a reply goes back into the thread it came from. Slack only listens for 3 seconds: `parse` does no I/O.
 */
export class SlackChannel implements ChannelAdapter {
  readonly kind = "slack" as const;
  readonly client = "im" as const;
  readonly scope = "";
  readonly maxFileBytes = 20 * 1024 * 1024;
  constructor(private config: SlackConfig, private fetchImpl: typeof fetch = fetch) {}

  /** Streaming replies (chat.startStream) and a status line are Slack features; a reply can also be edited. */
  capabilities(): ChannelCapabilities { return { stream: true, edit: true, typing: true, buttons: true, maxLength: MAX_TEXT, canInitiate: true, idempotentSend: false }; }
  available(): boolean { return Boolean(this.config.signingSecret && this.config.tokens); }

  /** The workspace installs the app here; `state` comes back with the code. */
  connectUrl(state: string): string | undefined {
    const { clientId, redirectUri } = this.config;
    return clientId && redirectUri ? `https://slack.com/oauth/v2/authorize?${new URLSearchParams({ client_id: clientId, scope: SCOPES, redirect_uri: redirectUri, state })}` : undefined;
  }

  /** Trades the code from the install redirect for the workspace's bot token. The caller stores it. */
  async install(code: string): Promise<{ team: string; token: string; botUserId: string }> {
    const { clientId, clientSecret, redirectUri } = this.config;
    if (!clientId || !clientSecret || !redirectUri) throw new Error("Slack OAuth is not configured");
    const response = await this.fetchImpl(`${API}/oauth.v2.access`, { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }), signal: AbortSignal.timeout(15_000) });
    const payload = await response.json().catch(() => ({})) as Json;
    if (!payload.ok || !payload.access_token || !payload.team?.id) throw new Error(`Slack install failed: ${payload.error ?? response.status}`);
    return { team: payload.team.id, token: payload.access_token, botUserId: payload.bot_user_id };
  }

  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const supplied = headers["x-slack-signature"]?.toString();
    const timestamp = headers["x-slack-request-timestamp"]?.toString();
    const { signingSecret } = this.config;
    if (!signingSecret || !supplied || !timestamp || Math.abs((this.config.now?.() ?? Date.now()) - Number(timestamp) * 1000) > REPLAY_MS) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(`v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:`).update(raw).digest("hex")}`);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parse(raw: Buffer): { events: InboundEvent[]; respond?: unknown } {
    const body = raw.toString("utf8");
    // A button press arrives form-encoded, with the JSON in `payload`.
    if (body.startsWith("payload=")) return { events: this.pressed(JSON.parse(new URLSearchParams(body).get("payload") ?? "{}")) };
    const envelope = JSON.parse(body) as Json;
    if (envelope.type === "url_verification") return { events: [], respond: { challenge: envelope.challenge } };
    return { events: envelope.type === "event_callback" ? this.message(envelope) : [] };
  }

  private message(envelope: Json): InboundEvent[] {
    const event = envelope.event as Json;
    const team = envelope.team_id as string | undefined;
    const direct = event.type === "message" && event.channel_type === "im";
    // Our own posts and edits come back as events; only a person's new message or file is one of ours.
    const ours = direct ? !event.subtype || event.subtype === "file_share" : event.type === "app_mention";
    if (!team || !ours || !event.user || event.bot_id) return [];
    // In a channel the thread is the conversation: start one under the mention.
    const thread = event.thread_ts ?? (direct ? undefined : event.ts);
    const base = {
      address: { threadId: [team, event.channel, thread].filter(Boolean).join(":"), senderId: event.user as string }, scope: team, messageRef: event.ts as string,
      ...(direct ? {} : { group: true as const }),
    };
    const text = String(event.text ?? "").replace(MENTION, "").trim();
    const files = ((event.files ?? []) as Json[]).filter(file => file.url_private_download && file.mode !== "external" && file.file_access !== "check_file_info");
    if (!files.length) return [{ eventId: envelope.event_id, ...base, ...(text ? { text } : {}) }];
    return files.map((file, index) => ({
      eventId: index ? `${envelope.event_id}:${index}` : envelope.event_id, ...base, ...(index || !text ? {} : { text }),
      file: { ref: `${team}|${file.url_private_download}`, name: file.name ?? "file", ...(file.size ? { size: file.size } : {}) },
    }));
  }

  private pressed(payload: Json): InboundEvent[] {
    if (payload.type !== "block_actions") return [];
    const team = payload.team?.id ?? payload.user?.team_id;
    const { channel, message } = payload;
    if (!team || !channel?.id || !message?.ts) return [];
    const thread = message.thread_ts && message.thread_ts !== message.ts ? message.thread_ts : undefined;
    return ((payload.actions ?? []) as Json[]).flatMap((action, index) => {
      const button = parseButtonId(action.value);
      return button ? [{
        eventId: `${payload.trigger_id}:${index}`, scope: team as string, messageRef: message.ts as string,
        address: { threadId: [team, channel.id, thread].filter(Boolean).join(":"), senderId: payload.user.id as string },
        button: { ...button, ref: `${channel.id}|${message.ts}` },
      }] : [];
    });
  }

  async send(to: PlatformAddress, message: OutboundMessage, _key: string): Promise<void> {
    const [team, channel, thread] = to.threadId.split(":") as [string, string, string | undefined];
    const buttons = message.buttons?.length ? [
      { type: "section", text: { type: "mrkdwn", text: message.text } },
      { type: "actions", elements: message.buttons.map(button => ({ type: "button", text: { type: "plain_text", text: fitLabel(button.label, MAX_BUTTON_LABEL) }, action_id: buttonId(button), value: buttonId(button) })) },
    ] : undefined;
    await this.call("chat.postMessage", await this.token(team), { channel, text: message.text, unfurl_links: false, unfurl_media: false, ...(thread ? { thread_ts: thread } : {}), ...(buttons ? { blocks: buttons } : {}) });
  }

  /** Removes the pressed message's buttons, so a task is not answered twice. */
  async acknowledge(event: InboundEvent, text?: string): Promise<void> {
    const [channel, ts] = event.button?.ref?.split("|") ?? [];
    if (!channel || !ts || !event.scope) return;
    await this.call("chat.update", await this.token(event.scope), { channel, ts, text: text ?? "✓", blocks: [] });
  }

  async download(file: InboundFile): Promise<Buffer> {
    const [team, link] = [file.ref.slice(0, file.ref.indexOf("|")), file.ref.slice(file.ref.indexOf("|") + 1)];
    const url = new URL(link);
    // The token goes only to Slack's own file host, and never follows a redirect elsewhere.
    if (url.protocol !== "https:" || url.hostname !== "files.slack.com") throw new Error("Slack file is not on files.slack.com");
    const response = await this.fetchImpl(url, { headers: { authorization: `Bearer ${await this.token(team)}` }, redirect: "error", signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`Slack file download failed: ${response.status}`);
    if (Number(response.headers.get("content-length")) > this.maxFileBytes) throw new Error(`Slack file is over ${this.maxFileBytes} bytes`);
    return Buffer.from(await response.arrayBuffer());
  }

  private async token(team: string): Promise<string> {
    const token = await this.config.tokens?.(team);
    if (!token) throw new ChannelSendError(`Slack access for ${team} is gone or was never granted`, "permanent", { access: true });
    return token;
  }

  /** Slack answers 200 with `ok: false` for most failures, so the error name decides. */
  private async call(method: string, token: string, body: Json): Promise<void> {
    await guardSend(`Slack ${method}`, async () => {
      const response = await this.fetchImpl(`${API}/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
      const payload = await response.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (response.ok && payload.ok) return;
      const error = payload.error ?? String(response.status);
      const failure = error === "ratelimited" || response.status === 429 ? "definite" : TRANSIENT.has(error) ? "ambiguous" : response.ok ? "permanent" : failureForStatus(response.status);
      const wait = Number(response.headers.get("retry-after")) * 1000;
      throw new ChannelSendError(`Slack ${method} failed: ${error}`, failure, { access: ACCESS_LOST.has(error) || lostAccess(response.status), ...(failure === "definite" && wait > 0 ? { retryAfterMs: wait } : {}) });
    });
  }
}
