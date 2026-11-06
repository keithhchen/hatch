import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { CredentialSeal } from "../assistant/channelCredentials.js";
import type { BrowserCookie, BrowserProfile, BrowserProfileStore, ProfileLease } from "./ports.js";

type Outcome = Parameters<BrowserProfileStore["release"]>[1];
type NewProfile = Parameters<BrowserProfileStore["put"]>[0];

// ---- Domain: pure rules shared by every adapter. Adapters only persist. ----

/** A profile together with who currently holds it. */
export type HeldProfile = BrowserProfile & { lease?: { id: string; holder: string; expiresAt: number } };

const cookieKey = (cookie: BrowserCookie) => `${cookie.name}\u0000${cookie.domain.toLowerCase()}\u0000${cookie.path}`;
const cookieExpired = (nowMs: number) => (cookie: BrowserCookie) => cookie.expires !== undefined && cookie.expires > 0 && cookie.expires * 1000 < nowMs;

/** New values replace old by (name, domain, path); cookies not mentioned are kept; expired ones are dropped. */
export function mergeCookies(stored: BrowserCookie[], fresh: BrowserCookie[], nowMs = Date.now()): BrowserCookie[] {
  const merged = new Map<string, BrowserCookie>();
  for (const cookie of [...stored, ...fresh]) merged.set(cookieKey(cookie), cookie);
  return [...merged.values()].filter(cookie => !cookieExpired(nowMs)(cookie));
}

/** A profile can be leased when it is ready and nobody holds an unexpired lease on it. */
export const isLeasable = (nowMs: number) => (profile: HeldProfile) => profile.status === "ready" && (!profile.lease || profile.lease.expiresAt < nowMs);

/** The leasable profile per requested platform that was used least recently (never-used first). */
export function chooseLeases(profiles: HeldProfile[], platforms: string[], nowMs: number): HeldProfile[] {
  const free = profiles.filter(isLeasable(nowMs)).filter(profile => platforms.includes(profile.platform));
  return [...new Set(free.map(profile => profile.platform))].map(platform =>
    free.filter(profile => profile.platform === platform).reduce((best, next) => ((next.lastUsedAt ?? "") < (best.lastUsedAt ?? "") ? next : best)));
}

/** Each granted profile gets its own lease id: releasing one profile must never settle another leased in the same call. */
export const grant = (holder: string, ttlMs: number, nowMs: number, newLeaseId: () => string = randomUUID) => (profile: HeldProfile): HeldProfile =>
  ({ ...profile, lease: { id: newLeaseId(), holder, expiresAt: nowMs + ttlMs }, lastUsedAt: new Date(nowMs).toISOString() });

/** Ends a live lease. A missing, mismatched or expired lease settles nothing, so a late run can never clobber a newer holder. */
export function settle(profile: HeldProfile, leaseId: string, outcome: Outcome, nowMs: number): HeldProfile | undefined {
  if (profile.lease?.id !== leaseId || profile.lease.expiresAt < nowMs) return undefined;
  const { lease: _lease, note: _note, ...rest } = profile;
  return { ...rest, cookies: outcome.cookies ? mergeCookies(profile.cookies, outcome.cookies, nowMs) : profile.cookies, status: outcome.status, ...(outcome.note === undefined ? {} : { note: outcome.note }), updatedAt: new Date(nowMs).toISOString() };
}

const asLease = ({ lease, ...profile }: HeldProfile): ProfileLease => ({ profile: structuredClone(profile), leaseId: lease!.id, expiresAt: new Date(lease!.expiresAt).toISOString() });
const asProfile = ({ lease: _lease, ...profile }: HeldProfile): BrowserProfile => structuredClone(profile);

// ---- Cookie exports: a registry of pluggable formats. Adding a format is one entry. ----

export type CookieFormat = { name: string; matches(json: unknown): boolean; parse(json: unknown): unknown[] };

const SAME_SITE: Record<string, BrowserCookie["sameSite"]> = { strict: "Strict", lax: "Lax", none: "None", no_restriction: "None" };

/** Reads the fields shared by all browser exports (Playwright, Cookie-Editor / EditThisCookie, DevTools). */
function normalizeCookie(raw: any, index: number): BrowserCookie {
  if (!raw || typeof raw !== "object" || typeof raw.name !== "string" || typeof raw.value !== "string" || typeof raw.domain !== "string" || !raw.domain) {
    throw new Error(`Cookie #${index + 1} needs string name, value and domain`);
  }
  const cookie: BrowserCookie = { name: raw.name, value: raw.value, domain: raw.domain, path: typeof raw.path === "string" && raw.path ? raw.path : "/" };
  const expiry = Number(raw.expires ?? raw.expirationDate);
  if (raw.session !== true && Number.isFinite(expiry) && expiry > 0) cookie.expires = expiry > 1e11 ? Math.round(expiry / 1000) : expiry;
  if (typeof raw.httpOnly === "boolean") cookie.httpOnly = raw.httpOnly;
  if (typeof raw.secure === "boolean") cookie.secure = raw.secure;
  const sameSite = typeof raw.sameSite === "string" ? SAME_SITE[raw.sameSite.toLowerCase()] : undefined;
  if (sameSite) cookie.sameSite = sameSite;
  return cookie;
}

export const COOKIE_FORMATS: CookieFormat[] = [
  { name: "playwright-storage-state", matches: json => !!json && typeof json === "object" && Array.isArray((json as any).cookies), parse: json => (json as any).cookies },
  { name: "cookie-array (Cookie-Editor, EditThisCookie, DevTools)", matches: Array.isArray, parse: json => json as unknown[] },
];

export function cookiesFromExport(json: unknown, formats: CookieFormat[] = COOKIE_FORMATS): BrowserCookie[] {
  const data = typeof json === "string" ? parseJson(json) : json;
  const format = formats.find(candidate => candidate.matches(data));
  if (!format) throw new Error("Not a cookie export: expected a cookie array or a Playwright storageState with a cookies array");
  return format.parse(data).map(normalizeCookie);
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("Not a cookie export: the text is not valid JSON"); }
}

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "edu", "ac"]);

/** Registrable hosts the cookies apply to, as root + wildcard: `.xiaohongshu.com` gives xiaohongshu.com and *.xiaohongshu.com. */
export function hostsForCookies(cookies: BrowserCookie[]): string[] {
  const roots = new Set<string>();
  for (const { domain } of cookies) {
    const labels = domain.replace(/^\./, "").toLowerCase().split(".");
    const keep = labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
    roots.add(labels.slice(-keep).join("."));
  }
  return [...roots].sort().flatMap(root => [root, `*.${root}`]);
}

// ---- Adapters ----

/** Runs `work` in a transaction on one connection. */
const inTransaction = (pool: Pool) => async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export class PostgresBrowserProfiles implements BrowserProfileStore {
  private transaction: ReturnType<typeof inTransaction>;
  private constructor(private pool: Pool, private seal: CredentialSeal) { this.transaction = inTransaction(pool); }
  static async open(pool: Pool, seal: CredentialSeal): Promise<PostgresBrowserProfiles> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_browser_profiles (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL,
        platform TEXT NOT NULL,
        label TEXT NOT NULL,
        hosts JSONB NOT NULL DEFAULT '[]'::jsonb,
        sealed TEXT NOT NULL,
        fingerprint JSONB NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ready', 'needs_login')),
        note TEXT,
        lease_id UUID,
        lease_holder TEXT,
        lease_expires_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hatch_browser_profiles_account_idx ON hatch_browser_profiles (account_id, platform);
    `);
    return new PostgresBrowserProfiles(pool, seal);
  }
  async put(profile: NewProfile): Promise<BrowserProfile> {
    const row = (await this.pool.query(
      `INSERT INTO hatch_browser_profiles (id, account_id, platform, label, hosts, sealed, fingerprint, status, note, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8, $9, NOW())
       ON CONFLICT (id) DO UPDATE SET platform = EXCLUDED.platform, label = EXCLUDED.label, hosts = EXCLUDED.hosts, sealed = EXCLUDED.sealed,
         fingerprint = EXCLUDED.fingerprint, status = EXCLUDED.status, note = EXCLUDED.note, updated_at = NOW()
       WHERE hatch_browser_profiles.account_id = EXCLUDED.account_id RETURNING *`,
      [profile.id ?? randomUUID(), profile.accountId, profile.platform, profile.label, JSON.stringify(profile.hosts), this.seal.seal({ cookies: profile.cookies, proxy: profile.proxy }), JSON.stringify(profile.fingerprint), profile.status, profile.note ?? null],
    )).rows[0];
    if (!row) throw Object.assign(new Error("Browser profile was not found"), { status: 404 });
    return asProfile(fromRow(row, this.seal));
  }
  async list(accountId: string): Promise<BrowserProfile[]> {
    return (await this.pool.query("SELECT * FROM hatch_browser_profiles WHERE account_id = $1 ORDER BY updated_at DESC, id", [accountId])).rows.map(row => asProfile(fromRow(row, this.seal)));
  }
  /** Row locks serialise concurrent leases; the shared domain rules decide who gets what. */
  async lease(accountId: string, platforms: string[], holder: string, ttlMs: number): Promise<ProfileLease[]> {
    return this.transaction(async client => {
      const { rows } = await client.query("SELECT *, NOW() AS db_now FROM hatch_browser_profiles WHERE account_id = $1 AND platform = ANY($2) AND status = 'ready' ORDER BY id FOR UPDATE", [accountId, platforms]);
      if (!rows.length) return [];
      const now = rows[0].db_now.getTime();
      const granted = chooseLeases(rows.map(row => fromRow(row, this.seal)), platforms, now).map(grant(holder, ttlMs, now));
      for (const profile of granted) await this.save(client, profile);
      return granted.map(asLease);
    });
  }
  async release(leaseId: string, outcome: Outcome): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(leaseId)) return;
    await this.transaction(async client => {
      const row = (await client.query("SELECT *, NOW() AS db_now FROM hatch_browser_profiles WHERE lease_id = $1 FOR UPDATE", [leaseId])).rows[0];
      const settled = row && settle(fromRow(row, this.seal), leaseId, outcome, row.db_now.getTime());
      if (settled) await this.save(client, settled);
    });
  }
  async remove(accountId: string, id: string): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return;
    await this.pool.query("DELETE FROM hatch_browser_profiles WHERE account_id = $1 AND id = $2", [accountId, id]);
  }
  private save(client: PoolClient, profile: HeldProfile) {
    return client.query(
      `UPDATE hatch_browser_profiles SET sealed = $2, status = $3, note = $4, lease_id = $5, lease_holder = $6,
         lease_expires_at = $7, last_used_at = $8, updated_at = $9 WHERE id = $1`,
      [profile.id, this.seal.seal({ cookies: profile.cookies, proxy: profile.proxy }), profile.status, profile.note ?? null, profile.lease?.id ?? null, profile.lease?.holder ?? null,
        profile.lease ? new Date(profile.lease.expiresAt) : null, profile.lastUsedAt ?? null, profile.updatedAt],
    );
  }
}

/** Explicit test dependency; the product never constructs this store. */
export class MemoryBrowserProfiles implements BrowserProfileStore {
  readonly profiles = new Map<string, HeldProfile>();
  async put(input: NewProfile): Promise<BrowserProfile> {
    const id = input.id ?? randomUUID();
    const existing = this.profiles.get(id);
    if (existing && existing.accountId !== input.accountId) throw Object.assign(new Error("Browser profile was not found"), { status: 404 });
    const profile: HeldProfile = { ...structuredClone(input), id, updatedAt: new Date().toISOString() };
    if (existing?.lastUsedAt) profile.lastUsedAt = existing.lastUsedAt;
    if (existing?.lease) profile.lease = existing.lease;
    this.profiles.set(id, profile);
    return asProfile(profile);
  }
  async list(accountId: string) {
    return [...this.profiles.values()].filter(profile => profile.accountId === accountId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(asProfile);
  }
  async lease(accountId: string, platforms: string[], holder: string, ttlMs: number): Promise<ProfileLease[]> {
    const now = Date.now();
    const granted = chooseLeases([...this.profiles.values()].filter(profile => profile.accountId === accountId), platforms, now).map(grant(holder, ttlMs, now));
    for (const profile of granted) this.profiles.set(profile.id, profile);
    return granted.map(asLease);
  }
  async release(leaseId: string, outcome: Outcome): Promise<void> {
    const held = [...this.profiles.values()].find(profile => profile.lease?.id === leaseId);
    const settled = held && settle(held, leaseId, outcome, Date.now());
    if (settled) this.profiles.set(settled.id, settled);
  }
  async remove(accountId: string, id: string) { if (this.profiles.get(id)?.accountId === accountId) this.profiles.delete(id); }
}

function iso(value: unknown) { return value instanceof Date ? value.toISOString() : typeof value === "string" ? value : undefined; }

function fromRow(row: Record<string, any>, seal: CredentialSeal): HeldProfile {
  const secret = seal.open<{ cookies: BrowserCookie[]; proxy?: string }>(row.sealed);
  const profile: HeldProfile = {
    id: row.id, accountId: row.account_id, platform: row.platform, label: row.label, hosts: row.hosts ?? [], cookies: secret.cookies,
    fingerprint: row.fingerprint, status: row.status, updatedAt: iso(row.updated_at)!,
  };
  if (secret.proxy) profile.proxy = secret.proxy;
  if (row.note) profile.note = row.note;
  if (row.last_used_at) profile.lastUsedAt = iso(row.last_used_at);
  if (row.lease_id) profile.lease = { id: row.lease_id, holder: row.lease_holder, expiresAt: row.lease_expires_at.getTime() };
  return profile;
}
