import { randomBytes } from "node:crypto";
import type { Pool } from "pg";
import type { Rate, RateLimiter } from "../channels/rateLimiter.js";
import { CHANNEL_LABELS, type ChannelKind } from "../channels/types.js";
import type { Account, AccountStoreTs } from "../registryAuth.js";
import { LoginError, pkce } from "./oidc.js";

const TRANSACTION_MS = 10 * 60_000;
const CLAIM_MS = 15 * 60_000;
const START_RATE: Rate = { capacity: 30, perSecond: 2 };
const CLAIM_RATE: Rate = { capacity: 3, perSecond: 1 / 60 };

/** Port: one platform as an identity provider. It says who a person is on that platform, as the id the platform's bot sees them by. */
export interface IdentityProvider {
  authorizeUrl(input: { redirectUri: string; state: string; nonce: string; challenge: string }): string;
  /** Trades the code for who the person is. Throws a LoginError when the platform does not vouch for anyone. */
  identify(input: { code: string; verifier: string; redirectUri: string; nonce: string; now: number }): Promise<{ subject: string; name?: string }>;
}

/** A sign-in in flight: its single-use `state`, and what only we know about it. */
export type LoginTransaction = { kind: ChannelKind; state: string; verifier: string; nonce: string; claim?: string; returnTo: string };
/** A one-time permission, handed to one platform id in its chat with the bot, to sign in from that chat. */
export type LoginClaim = { kind: ChannelKind; subject: string; invite?: string };

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
    // Rows written before a platform was recorded are Telegram's.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_login_transactions (
        state TEXT PRIMARY KEY, verifier TEXT NOT NULL, nonce TEXT NOT NULL, claim TEXT, return_to TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_login_claims (
        code TEXT PRIMARY KEY, subject TEXT NOT NULL, invite TEXT, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ
      );
      ALTER TABLE auth_login_transactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'telegram';
      ALTER TABLE auth_login_claims ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'telegram'`);
    return new PostgresLoginStore(pool);
  }
  async begin(t: LoginTransaction, expiresAt: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_login_transactions WHERE expires_at < now()");
    await this.pool.query("INSERT INTO auth_login_transactions (state, verifier, nonce, claim, return_to, expires_at, kind) VALUES ($1,$2,$3,$4,$5,$6,$7)", [t.state, t.verifier, t.nonce, t.claim ?? null, t.returnTo, expiresAt, t.kind]);
  }
  async take(state: string, now: Date): Promise<LoginTransaction | undefined> {
    const row = (await this.pool.query("DELETE FROM auth_login_transactions WHERE state = $1 AND expires_at > $2 RETURNING verifier, nonce, claim, return_to, kind", [state, now])).rows[0];
    return row && { kind: row.kind, state, verifier: row.verifier, nonce: row.nonce, ...(row.claim ? { claim: row.claim } : {}), returnTo: row.return_to };
  }
  async issueClaim(code: string, claim: LoginClaim, expiresAt: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_login_claims WHERE expires_at < now() - interval '1 day'");
    await this.pool.query("INSERT INTO auth_login_claims (code, subject, invite, expires_at, kind) VALUES ($1,$2,$3,$4,$5)", [code, claim.subject, claim.invite ?? null, expiresAt, claim.kind]);
  }
  private static claimOf = (row?: { kind: ChannelKind; subject: string; invite: string | null }): LoginClaim | undefined => row && { kind: row.kind, subject: row.subject, ...(row.invite ? { invite: row.invite } : {}) };
  async peekClaim(code: string, now: Date): Promise<LoginClaim | undefined> {
    return PostgresLoginStore.claimOf((await this.pool.query("SELECT kind, subject, invite FROM auth_login_claims WHERE code = $1 AND used_at IS NULL AND expires_at > $2", [code, now])).rows[0]);
  }
  async useClaim(code: string, now: Date): Promise<LoginClaim | undefined> {
    return PostgresLoginStore.claimOf((await this.pool.query("UPDATE auth_login_claims SET used_at = $2 WHERE code = $1 AND used_at IS NULL AND expires_at > $2 RETURNING kind, subject, invite", [code, now])).rows[0]);
  }
}

export type LoginOutcome = { account: Account; created: boolean; returnTo: string };

/**
 * Platforms as identity providers. A platform id (the sender id its bot sees) is an identity of exactly one account.
 * Two ways in, the same flow: from the site, or from the bot's own chat, where a claim ties the sign-in to the sender id the bot saw.
 */
export class PlatformLogin {
  constructor(private deps: {
    providers: Partial<Record<ChannelKind, IdentityProvider>>; store: LoginStore; accounts: Pick<AccountStoreTs, "signInWithIdentity">; limiter: RateLimiter;
    /** The public origin of the site the provider sends the person back to. */
    origin: string;
    /** After a sign-in that started from a chat: bind that chat (or admit an invitee). Failing refuses the sign-in. */
    admit: (kind: ChannelKind, account: Account, subject: string, claim: LoginClaim) => Promise<void>;
    now?: () => Date;
  }) {}

  private now(): Date { return this.deps.now?.() ?? new Date(); }
  /** The platforms a person can sign in with right now. */
  kinds(): ChannelKind[] { return Object.keys(this.deps.providers) as ChannelKind[]; }
  enabled(kind: string): kind is ChannelKind { return Object.hasOwn(this.deps.providers, kind); }
  redirectUri(kind: ChannelKind): string { return `${this.deps.origin}/v1/auth/${kind}/callback`; }
  private provider(kind: ChannelKind): IdentityProvider {
    const provider = this.deps.providers[kind];
    if (!provider) throw new LoginError("login_unavailable", `${CHANNEL_LABELS[kind]} sign-in is not available.`, 503);
    return provider;
  }

  private async throttle(key: string, rate: Rate): Promise<void> {
    if (await this.deps.limiter.take(key, rate, this.now())) throw new LoginError("rate_limited", "Too many sign-in attempts. Try again shortly.", 429);
  }

  /** The link the bot puts in front of a sender it does not know. Undefined when the platform has no sign-in, or this sender has asked too often. */
  async claimLink(kind: ChannelKind, subject: string, invite?: string): Promise<string | undefined> {
    if (!this.enabled(kind) || await this.deps.limiter.take(`auth:${kind}:claim:${subject}`, CLAIM_RATE, this.now())) return undefined;
    const code = randomBytes(24).toString("base64url");
    await this.deps.store.issueClaim(code, { kind, subject, ...(invite ? { invite } : {}) }, new Date(this.now().getTime() + CLAIM_MS));
    return `${this.deps.origin}/v1/auth/${kind}/start?claim=${code}`;
  }

  async start(kind: ChannelKind, input: { claim?: string; returnTo?: string }): Promise<{ authorizeUrl: string; state: string }> {
    const provider = this.provider(kind);
    await this.throttle(`auth:${kind}:start`, START_RATE);
    if (input.claim && (await this.deps.store.peekClaim(input.claim, this.now()))?.kind !== kind) throw new LoginError("claim_invalid", "This sign-in link has expired. Ask the bot again.", 410);
    const { verifier, challenge } = pkce();
    const state = randomBytes(24).toString("base64url"); const nonce = randomBytes(16).toString("base64url");
    const returnTo = input.returnTo?.startsWith("/") && !input.returnTo.startsWith("//") && !input.returnTo.startsWith("/\\") ? input.returnTo : "/";
    await this.deps.store.begin({ kind, state, verifier, nonce, ...(input.claim ? { claim: input.claim } : {}), returnTo }, new Date(this.now().getTime() + TRANSACTION_MS));
    return { authorizeUrl: provider.authorizeUrl({ redirectUri: this.redirectUri(kind), state, nonce, challenge }), state };
  }

  async finish(kind: ChannelKind, input: { code: string; state: string }): Promise<LoginOutcome> {
    const provider = this.provider(kind);
    await this.throttle(`auth:${kind}:callback`, START_RATE);
    // A state is spent where it is presented, so one started for another platform is spent too.
    const transaction = await this.deps.store.take(input.state, this.now());
    if (transaction?.kind !== kind) throw new LoginError("login_state_invalid", "This sign-in has expired. Start again.", 400);
    const { subject, name } = await provider.identify({ code: input.code, verifier: transaction.verifier, redirectUri: this.redirectUri(kind), nonce: transaction.nonce, now: this.now().getTime() });
    // Used even when it does not fit: a link that someone else tapped is spent.
    const claim = transaction.claim ? await this.deps.store.useClaim(transaction.claim, this.now()) : undefined;
    if (transaction.claim && (!claim || claim.kind !== kind || claim.subject !== subject)) throw new LoginError("claim_mismatch", `This sign-in link belongs to another ${CHANNEL_LABELS[kind]} account.`, 403);
    const { account, created } = await this.deps.accounts.signInWithIdentity(kind, subject, name ?? CHANNEL_LABELS[kind]);
    if (claim) await this.deps.admit(kind, account, subject, claim);
    return { account, created, returnTo: transaction.returnTo };
  }
}
