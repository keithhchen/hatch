import { createHash, createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

export type AccountRole = "user" | "creator";
export type Account = { id: string; role: AccountRole; email: string; display_name: string; password_salt: string; password_hash: string; created_at: string };
export type AccountPublic = Pick<Account, "id" | "role" | "email" | "display_name">;
export type AccountSession = {
  id: string;
  account_id: string;
  token_hash: string;
  client_type: "desktop";
  created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at?: string;
};
export type AuthenticatedSession = { account: Account; session: AccountSession };

const SESSION_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;

export class AccountStoreTs {
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, AccountSession>();

  constructor(private readonly pool?: Pool) {}

  async ensureSchema(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL CHECK (role IN ('user', 'creator')),
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_sessions (
      id UUID PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      client_type TEXT NOT NULL DEFAULT 'desktop' CHECK (client_type = 'desktop'),
      created_at TIMESTAMPTZ NOT NULL,
      last_seen_at TIMESTAMPTZ NOT NULL,
      idle_expires_at TIMESTAMPTZ NOT NULL,
      absolute_expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS account_sessions_account_active_idx
      ON account_sessions(account_id)
      WHERE revoked_at IS NULL`);
  }

  async getByEmail(email: string): Promise<Account | undefined> {
    const normalized = email.trim().toLowerCase();
    if (!this.pool) return [...this.accounts.values()].find((account) => account.email === normalized);
    const result = await this.pool.query("SELECT id, role, email, display_name, password_salt, password_hash, created_at FROM accounts WHERE email=$1", [normalized]);
    return result.rows[0] ? rowToAccount(result.rows[0]) : undefined;
  }

  async getById(id: string): Promise<Account | undefined> {
    if (!this.pool) return this.accounts.get(id);
    const result = await this.pool.query("SELECT id, role, email, display_name, password_salt, password_hash, created_at FROM accounts WHERE id=$1", [id]);
    return result.rows[0] ? rowToAccount(result.rows[0]) : undefined;
  }

  async create(email: string, password: string, role: AccountRole, displayName: string): Promise<Account> {
    const normalized = normalizeSignup(email, password, role, displayName);
    if (await this.getByEmail(normalized.email)) throw new Error("email_already_registered");
    const salt = randomBytes(16);
    const account: Account = {
      id: accountId(role, normalized.displayName),
      role,
      email: normalized.email,
      display_name: normalized.displayName,
      password_salt: salt.toString("base64url"),
      password_hash: derivePassword(password, salt),
      created_at: new Date().toISOString(),
    };
    if (this.pool) {
      await this.pool.query("INSERT INTO accounts (id, role, email, display_name, password_salt, password_hash, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)", [account.id, account.role, account.email, account.display_name, account.password_salt, account.password_hash, account.created_at]);
    } else this.accounts.set(account.id, account);
    return account;
  }

  async createSession(account: Account, now = Date.now()): Promise<{ token: string; session: AccountSession }> {
    const token = randomBytes(32).toString("base64url");
    const createdAt = new Date(now).toISOString();
    const session: AccountSession = {
      id: randomUUID(),
      account_id: account.id,
      token_hash: hashSessionToken(token),
      client_type: "desktop",
      created_at: createdAt,
      last_seen_at: createdAt,
      idle_expires_at: new Date(now + SESSION_IDLE_MS).toISOString(),
      absolute_expires_at: new Date(now + SESSION_ABSOLUTE_MS).toISOString()
    };
    if (this.pool) {
      await this.pool.query(`INSERT INTO account_sessions
        (id, account_id, token_hash, client_type, created_at, last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [
        session.id,
        session.account_id,
        session.token_hash,
        session.client_type,
        session.created_at,
        session.last_seen_at,
        session.idle_expires_at,
        session.absolute_expires_at
      ]);
    } else {
      this.sessions.set(session.token_hash, session);
    }
    return { token, session };
  }

  async resolveSession(token: string | undefined, now = Date.now()): Promise<AuthenticatedSession | undefined> {
    if (!token) return undefined;
    const tokenHash = hashSessionToken(token);
    if (!this.pool) {
      const session = this.sessions.get(tokenHash);
      if (!session || !sessionIsActive(session, now)) {
        if (session) this.sessions.delete(tokenHash);
        return undefined;
      }
      const account = this.accounts.get(session.account_id);
      if (!account) return undefined;
      const nextSession = refreshedSession(session, now);
      this.sessions.set(tokenHash, nextSession);
      return { account, session: nextSession };
    }

    const result = await this.pool.query(`SELECT
      s.id, s.account_id, s.token_hash, s.client_type, s.created_at, s.last_seen_at,
      s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
      a.id AS account_id_value, a.role, a.email, a.display_name,
      a.password_salt, a.password_hash, a.created_at AS account_created_at
      FROM account_sessions AS s
      JOIN accounts AS a ON a.id = s.account_id
      WHERE s.token_hash=$1`, [tokenHash]);
    const row = result.rows[0];
    if (!row) return undefined;
    const session = rowToSession(row);
    if (!sessionIsActive(session, now)) return undefined;
    const refreshed = refreshedSession(session, now);
    await this.pool.query("UPDATE account_sessions SET last_seen_at=$2, idle_expires_at=$3 WHERE id=$1", [session.id, refreshed.last_seen_at, refreshed.idle_expires_at]);
    const account: Account = {
      id: String(row.account_id_value),
      role: row.role as AccountRole,
      email: String(row.email),
      display_name: String(row.display_name),
      password_salt: String(row.password_salt),
      password_hash: String(row.password_hash),
      created_at: new Date(row.account_created_at).toISOString()
    };
    return { account, session: refreshed };
  }

  async revokeSession(token: string | undefined): Promise<void> {
    if (!token) return;
    const tokenHash = hashSessionToken(token);
    if (this.pool) {
      await this.pool.query("UPDATE account_sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL", [tokenHash, new Date().toISOString()]);
      return;
    }
    this.sessions.delete(tokenHash);
  }
}

export function accountPublic(account: Account): AccountPublic {
  return { id: account.id, role: account.role, email: account.email, display_name: account.display_name };
}

export function verifyPassword(password: string, account: Account): boolean {
  const candidate = Buffer.from(derivePassword(password, Buffer.from(account.password_salt, "base64url")));
  const expected = Buffer.from(account.password_hash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function createAuthToken(account: Account, secret: string, now = Date.now()): string {
  const header = encodeJson({ alg: "HS256", typ: "HATCH" });
  const payload = encodeJson({ sub: account.id, role: account.role, exp: Math.floor(now / 1000) + 7 * 24 * 60 * 60 });
  return `${header}.${payload}.${sign(`${header}.${payload}`, secret)}`;
}

export function verifyAuthToken(token: string | undefined, secret: string | undefined): { sub: string; role: AccountRole; exp: number } | undefined {
  if (!token || !secret) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  const supplied = Buffer.from(parts[2]!, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (supplied.length !== expectedBytes.length || !timingSafeEqual(supplied, expectedBytes)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof payload.sub !== "string" || (payload.role !== "user" && payload.role !== "creator") || typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return undefined;
    return { sub: payload.sub, role: payload.role, exp: payload.exp };
  } catch { return undefined; }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function sessionIsActive(session: AccountSession, now: number): boolean {
  if (session.revoked_at) return false;
  return Date.parse(session.idle_expires_at) > now && Date.parse(session.absolute_expires_at) > now;
}

function refreshedSession(session: AccountSession, now: number): AccountSession {
  const absoluteExpiry = Date.parse(session.absolute_expires_at);
  const idleExpiry = Math.min(now + SESSION_IDLE_MS, absoluteExpiry);
  return {
    ...session,
    last_seen_at: new Date(now).toISOString(),
    idle_expires_at: new Date(idleExpiry).toISOString()
  };
}

function normalizeSignup(email: string, password: string, role: AccountRole, displayName: string): { email: string; displayName: string } {
  const normalizedEmail = email.trim().toLowerCase();
  const normalizedName = displayName.trim().replace(/\s+/g, " ");
  if (!normalizedEmail.includes("@") || normalizedEmail.length < 5) throw new Error("email_invalid");
  if (password.length < 8) throw new Error("password_too_short");
  if (role !== "user" && role !== "creator") throw new Error("role_invalid");
  if (!normalizedName) throw new Error("display_name_required");
  return { email: normalizedEmail, displayName: normalizedName };
}

function accountId(role: AccountRole, displayName: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const suffix = randomUUID().replaceAll("-", "").slice(0, 12);
  return `${slug || role}_${suffix}`;
}
function derivePassword(password: string, salt: Buffer): string { return scryptSync(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 }).toString("base64url"); }
function encodeJson(value: Record<string, unknown>): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function sign(value: string, secret: string): string { return createHmac("sha256", secret).update(value).digest("base64url"); }
function rowToAccount(row: Record<string, any>): Account {
  return {
    id: String(row.id),
    role: row.role as AccountRole,
    email: String(row.email),
    display_name: String(row.display_name),
    password_salt: String(row.password_salt),
    password_hash: String(row.password_hash),
    created_at: new Date(row.created_at).toISOString(),
  };
}

function rowToSession(row: Record<string, any>): AccountSession {
  return {
    id: String(row.id),
    account_id: String(row.account_id),
    token_hash: String(row.token_hash),
    client_type: "desktop",
    created_at: new Date(row.created_at).toISOString(),
    last_seen_at: new Date(row.last_seen_at).toISOString(),
    idle_expires_at: new Date(row.idle_expires_at).toISOString(),
    absolute_expires_at: new Date(row.absolute_expires_at).toISOString(),
    ...(row.revoked_at ? { revoked_at: new Date(row.revoked_at).toISOString() } : {})
  };
}
