import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Rate, RateLimiter } from "../channels/rateLimiter.js";
import type { Account, AccountStoreTs } from "../registryAuth.js";
import { LoginError, OidcClient, pkce, type OidcConfig } from "./oidc.js";

export const TELEGRAM_ISSUER = "https://oauth.telegram.org";
export const telegramOidc = (credentials: { clientId: string; clientSecret: string }, base = TELEGRAM_ISSUER): OidcConfig => ({
  issuer: TELEGRAM_ISSUER, authorizeUrl: `${base}/auth`, tokenUrl: `${base}/token`, jwksUrl: `${base}/.well-known/jwks.json`, ...credentials,
});

const TRANSACTION_MS = 10 * 60_000;
const CLAIM_MS = 15 * 60_000;
const START_RATE: Rate = { capacity: 30, perSecond: 2 };
const CLAIM_RATE: Rate = { capacity: 3, perSecond: 1 / 60 };
const SCOPES = ["openid", "profile", "telegram:bot_access"];

/** A sign-in in flight: its single-use `state`, and what only we know about it. */
export type LoginTransaction = { state: string; verifier: string; nonce: string; claim?: string; returnTo: string };
/** A one-time permission, handed to one Telegram id in its chat with the bot, to sign in from that chat. */
export type LoginClaim = { subject: string; invite?: string };

/** Port: what a sign-in keeps between its two requests. Both reads are single-use. */
export interface LoginStore {
  begin(transaction: LoginTransaction, expiresAt: Date): Promise<void>;
  take(state: string, now: Date): Promise<LoginTransaction | undefined>;
  issueClaim(code: string, claim: LoginClaim, expiresAt: Date): Promise<void>;
  /** Whether the claim could still be used, without using it. */
  peekClaim(code: string, now: Date): Promise<LoginClaim | undefined>;
  useClaim(code: string, now: Date): Promise<LoginClaim | undefined>;
}

export class PostgresLoginStore implements LoginStore {
  private constructor(private pool: Pool) {}
  static async open(pool: Pool): Promise<PostgresLoginStore> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_login_transactions (
        state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, claim TEXT, return_to TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_login_claims (
        code TEXT PRIMARY KEY, subject TEXT NOT NULL, invite TEXT, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
      )`);
    return new PostgresLoginStore(pool);
  }
  async begin(t: LoginTransaction, expiresAt: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_login_transactions WHERE expires_at < now()");
    await this.pool.query("INSERT INTO auth_login_transactions (state, verifier, nonce, claim, return_to, expires_at) VALUES ($1,$2,$3,$4,$5,$6)", [t.state, t.verifier, t.nonce, t.claim ?? null, t.returnTo, expiresAt]);
  }
  async take(state: string, now: Date): Promise<LoginTransaction | undefined> {
    const row = (await this.pool.query("DELETE FROM auth_login_transactions WHERE state = $1 AND expires_at > $2 RETURNING verifier, nonce, claim, return_to", [state, now])).rows[0];
    return row && { state, verifier: row.verifier, nonce: row.nonce, ...(row.claim ? { claim: row.claim } : {}), returnTo: row.return_to };
  }
  async issueClaim(code: string, claim: LoginClaim, expiresAt: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_login_claims WHERE expires_at < now() - interval '1 day'");
    await this.pool.query("INSERT INTO auth_login_claims (code, subject, invite, expires_at) VALUES ($1,$2,$3,$4)", [code, claim.subject, claim.invite ?? null, expiresAt]);
  }
  private static claimOf = (row?: { subject: string; invite: string | null }): LoginClaim | undefined => row && { subject: row.subject, ...(row.invite ? { invite: row.invite } : {}) };
  async peekClaim(code: string, now: Date): Promise<LoginClaim | undefined> {
    return PostgresLoginStore.claimOf((await this.pool.query("SELECT subject, invite FROM auth_login_claims WHERE code = $1 AND used_at IS NULL AND expires_at > $2", [code, now])).rows[0]);
  }
  async useClaim(code: string, now: Date): Promise<LoginClaim | undefined> {
    return PostgresLoginStore.claimOf((await this.pool.query("UPDATE auth_login_claims SET used_at = $2 WHERE code = $1 AND used_at IS NULL AND expires_at > $2 RETURNING subject, invite", [code, now])).rows[0]);
  }
}

export type LoginOutcome = { account: Account; created: boolean; returnTo: string };

/**
 * Telegram as an identity provider. A Telegram user id (the token's `id`) is an identity of exactly one account.
 * Two ways in, the same flow: from the site, or from the bot's own chat, where a claim ties the sign-in to the sender id the bot saw.
 */
export class TelegramLogin {
  constructor(private deps: {
    oidc: OidcClient; store: LoginStore; accounts: Pick<AccountStoreTs, "signInWithIdentity">; limiter: RateLimiter;
    /** The public origin of the site the provider sends the person back to. */
    origin: string;
    /** After a sign-in that started from a chat: bind that chat (or admit an invitee). Failing refuses the sign-in. */
    admit: (account: Account, telegramId: string, claim: LoginClaim) => Promise<void>;
    now?: () => Date;
  }) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  get redirectUri(): string { return `${this.deps.origin}/v1/auth/telegram/callback`; }

  private async throttle(key: string, rate: Rate): Promise<void> {
    if (await this.deps.limiter.take(key, rate, this.now())) throw new LoginError("rate_limited", "Too many sign-in attempts. Try again shortly.", 429);
  }

  /** The link the bot puts in front of a sender it does not know. Undefined when this sender has asked too often. */
  async claimLink(subject: string, invite?: string): Promise<string | undefined> {
    if (await this.deps.limiter.take(`auth:telegram:claim:${subject}`, CLAIM_RATE, this.now())) return undefined;
    const code = randomBytes(24).toString("base64url");
    await this.deps.store.issueClaim(code, { subject, ...(invite ? { invite } : {}) }, new Date(this.now().getTime() + CLAIM_MS));
    return `${this.deps.origin}/v1/auth/telegram/start?claim=${code}`;
  }

  async start(input: { claim?: string; returnTo?: string }): Promise<{ authorizeUrl: string; state: string }> {
    await this.throttle("auth:telegram:start", START_RATE);
    if (input.claim && !await this.deps.store.peekClaim(input.claim, this.now())) throw new LoginError("claim_invalid", "This sign-in link has expired. Ask the bot again.", 410);
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString("base64url"); const nonce = randomBytes(16).toString("base64url");
    const returnTo = input.returnTo?.startsWith("/") && !input.returnTo.startsWith("//") && !input.returnTo.startsWith("/\\") ? input.returnTo : "/";
    await this.deps.store.begin({ state, verifier, nonce, ...(input.claim ? { claim: input.claim } : {}), returnTo }, new Date(this.now().getTime() + TRANSACTION_MS));
    return { authorizeUrl: this.deps.oidc.authorizeUrl({ redirectUri: this.redirectUri, scopes: SCOPES, state, nonce, challenge }), state };
  }

  async finish(input: { code: string; state: string }): Promise<LoginOutcome> {
    await this.throttle("auth:telegram:callback", START_RATE);
    const transaction = await this.deps.store.take(input.state, this.now());
    if (!transaction) throw new LoginError("login_state_invalid", "This sign-in has expired. Start again.", 400);
    const claims = await this.deps.oidc.verifyIdToken(await this.deps.oidc.exchange({ code: input.code, verifier: transaction.verifier, redirectUri: this.redirectUri }), transaction.nonce, this.now().getTime());
    const telegramId = String(claims.id ?? "");
    if (!/^\d{1,20}$/.test(telegramId)) throw new LoginError("login_failed", "The sign-in did not say who you are.", 401);
    // Used even when it does not fit: a link that someone else tapped is spent.
    const claim = transaction.claim ? await this.deps.store.useClaim(transaction.claim, this.now()) : undefined;
    if (transaction.claim && (!claim || claim.subject !== telegramId)) throw new LoginError("claim_mismatch", "This sign-in link belongs to another Telegram account.", 403);
    const name = [claims.name, claims.preferred_username].find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "Telegram";
    const { account, created } = await this.deps.accounts.signInWithIdentity("telegram", telegramId, name);
    if (claim) await this.deps.admit(account, telegramId, claim);
    return { account, created, returnTo: transaction.returnTo };
  }
}
