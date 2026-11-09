import type { ChannelCapabilities } from "../surfaces/contract.js";
import type { GraphError, MetaConfig } from "./metaChannel.js";
import { MetaMessagingChannel } from "./metaMessaging.js";
import { CredentialsExpired } from "./types.js";

const API = "https://graph.instagram.com/v27.0";
const MAX_BYTES = 1000;
const SCOPES = "instagram_business_basic,instagram_business_manage_messages";
const DAY_MS = 24 * 60 * 60_000;
/** Renew in the last two weeks of the 60 days. */
const RENEW_WITHIN_MS = 14 * DAY_MS;
/** Error 100 with this subcode: Meta Business AI owns the conversation and the app was not handed it. */
const BUSINESS_AI_OWNS_THREAD = 2534037;

export type InstagramConfig = MetaConfig & { clientId?: string; clientSecret?: string; redirectUri?: string; now?: () => number };
type Token = { token: string; userId: string; expiresAt: number; refreshedAt: number };

/** Instagram Messaging (Instagram login). The tenant is the professional account, the contact the IGSID. */
export class InstagramChannel extends MetaMessagingChannel {
  readonly kind = "instagram" as const;
  protected readonly object = "instagram";
  /** The documented limit is 1000 bytes: the core renders text in pieces that fit it. */
  protected readonly textLimit = MAX_BYTES;
  constructor(protected override config: InstagramConfig, fetchImpl: typeof fetch = fetch) { super(config, fetchImpl); }
  protected endpoint(account: string): string { return `${API}/${account}/messages`; }
  capabilities(): ChannelCapabilities { return { ...super.capabilities(), maxBytes: MAX_BYTES }; }
  /** Not a delivery problem to retry: say who holds the conversation. */
  protected explain(error: GraphError = {}): string {
    return error.error_subcode === BUSINESS_AI_OWNS_THREAD ? `Instagram Business AI owns this conversation; reply only after it passes control (${error.code}/${error.error_subcode})` : super.explain(error);
  }

  /** Where the account owner logs in to install the app; `state` comes back with the code. */
  connectUrl(state: string): string | undefined {
    const { clientId, redirectUri } = this.config;
    return clientId && redirectUri ? `https://www.instagram.com/oauth/authorize?${new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPES, state })}` : undefined;
  }

  /** The install redirect: the code becomes a short-lived token, then a 60-day one, and the app subscribes to the account's messages. */
  async install(code: string): Promise<{ scope: string; credentials: Token }> {
    const { clientId, clientSecret, redirectUri } = this.config;
    if (!clientId || !clientSecret || !redirectUri) throw new Error("Instagram login is not configured");
    const now = this.config.now?.() ?? Date.now();
    const short = await this.json("https://api.instagram.com/oauth/access_token", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "authorization_code", redirect_uri: redirectUri, code }) });
    const { access_token: shortToken, user_id: userId } = short.data?.[0] ?? short;
    const long = await this.json(`https://graph.instagram.com/access_token?${new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: clientSecret, access_token: shortToken })}`);
    await this.call("POST", `${API}/${userId}/subscribed_apps?subscribed_fields=messages`, long.access_token);
    return { scope: String(userId), credentials: { token: long.access_token, userId: String(userId), expiresAt: now + long.expires_in * 1000, refreshedAt: now } };
  }

  /** A token lasts 60 days, can be renewed once it is a day old, and is lost if it expires first. */
  async refresh(credentials: Record<string, unknown>, at: Date): Promise<Token | undefined> {
    const current = credentials as Token;
    const now = at.getTime();
    if (current.expiresAt <= now) throw new CredentialsExpired("The Instagram token expired; the account has to install the app again");
    if (current.expiresAt - now > RENEW_WITHIN_MS || now - current.refreshedAt < DAY_MS) return undefined;
    const renewed = await this.json(`https://graph.instagram.com/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: current.token })}`);
    return { ...current, token: renewed.access_token, expiresAt: now + renewed.expires_in * 1000, refreshedAt: now };
  }

  private async json(url: string, init: RequestInit = {}): Promise<Record<string, any>> {
    const response = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(15_000) });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new Error(`Instagram refused the request: ${body.error?.message ?? body.error_message ?? response.status}`);
    return body;
  }
}
