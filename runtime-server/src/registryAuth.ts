import { createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
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
const MAX_EMAIL_LENGTH = 254;
const MAX_DISPLAY_NAME_LENGTH = 128;
const MAX_PASSWORD_BYTES = 1024;
const DUMMY_PASSWORD_SALT = Buffer.from("aGF0Y2gtYXV0aC1kdW1teQ", "base64url");
const DUMMY_PASSWORD_HASH = "GgnEEGHD4FH61njbBvExGZYO_ElDIZDZYcck-3crTvSAS-ax_FQ6fSLq3jheMCL8H7Ra6SMbFJ6cGx2_g11DVw";

export type PasswordWorkOptions = { concurrency: number; maxQueue: number };
export const DEFAULT_PASSWORD_WORK_OPTIONS: PasswordWorkOptions = { concurrency: 4, maxQueue: 64 };

export class PasswordWorkCapacityError extends Error {
  constructor() {
    super("Authentication password work capacity is exhausted");
    this.name = "PasswordWorkCapacityError";
  }
}

/** Bounds both active libuv scrypt work and the application-side wait queue. */
export class PasswordHasher {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly options: PasswordWorkOptions = DEFAULT_PASSWORD_WORK_OPTIONS) {
    if (!Number.isSafeInteger(options.concurrency) || options.concurrency <= 0) {
      throw new Error("Password scrypt concurrency must be a positive integer");
    }
    if (!Number.isSafeInteger(options.maxQueue) || options.maxQueue < 0) {
      throw new Error("Password scrypt maxQueue must be a non-negative integer");
    }
  }

  async derive(password: string, salt: Buffer): Promise<string> {
    await this.acquire();
    try {
      return await derivePasswordAsync(password, salt);
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.options.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.options.maxQueue) throw new PasswordWorkCapacityError();
    return new Promise<void>((resolve) => this.queue.push(resolve));
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active -= 1;
  }
}

const DEFAULT_PASSWORD_HASHER = new PasswordHasher();

export function passwordWorkOptionsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): PasswordWorkOptions {
  return {
    concurrency: integerEnvironmentSetting(
      environment,
      "HATCH_AUTH_SCRYPT_CONCURRENCY",
      DEFAULT_PASSWORD_WORK_OPTIONS.concurrency,
      1,
      32
    ),
    maxQueue: integerEnvironmentSetting(
      environment,
      "HATCH_AUTH_SCRYPT_MAX_QUEUE",
      DEFAULT_PASSWORD_WORK_OPTIONS.maxQueue,
      0,
      10_000
    )
  };
}

export class AccountStoreTs {
  private readonly accounts = new Map<string, Account>();
  private readonly sessions = new Map<string, AccountSession>();
  private readonly accountCreations = new Map<string, Promise<Account>>();

  constructor(
    private readonly pool?: Pool,
    private readonly passwordHasher: PasswordHasher = DEFAULT_PASSWORD_HASHER
  ) {}

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
    const normalized = normalizeAccountIdentity(email);
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
    const normalized = validateSignupCredentials(email, password, role, displayName);
    const previous = this.accountCreations.get(normalized.email);
    const creation = (previous ? previous.catch(() => undefined) : Promise.resolve(undefined))
      .then(() => this.createOnce(normalized.email, password, role, normalized.displayName));
    this.accountCreations.set(normalized.email, creation);
    try {
      return await creation;
    } finally {
      if (this.accountCreations.get(normalized.email) === creation) {
        this.accountCreations.delete(normalized.email);
      }
    }
  }

  private async createOnce(
    normalizedEmail: string,
    password: string,
    role: AccountRole,
    normalizedDisplayName: string,
  ): Promise<Account> {
    if (await this.getByEmail(normalizedEmail)) throw new Error("email_already_registered");
    const salt = randomBytes(16);
    const account: Account = {
      id: accountId(role, normalizedDisplayName),
      role,
      email: normalizedEmail,
      display_name: normalizedDisplayName,
      password_salt: salt.toString("base64url"),
      password_hash: await this.passwordHasher.derive(password, salt),
      created_at: new Date().toISOString(),
    };
    if (this.pool) {
      const result = await this.pool.query(
        `INSERT INTO accounts (id, role, email, display_name, password_salt, password_hash, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [account.id, account.role, account.email, account.display_name, account.password_salt, account.password_hash, account.created_at],
      );
      if (result.rowCount !== 1) throw new Error("email_already_registered");
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

    const nowIso = new Date(now).toISOString();
    const proposedIdleExpiry = new Date(now + SESSION_IDLE_MS).toISOString();
    // One conditional UPDATE is the session authority. It cannot return a row
    // that a concurrent logout has already revoked, and logout cannot return
    // until an earlier refresh holding the same row lock has completed.
    const result = await this.pool.query(`UPDATE account_sessions AS s
      SET last_seen_at=$2::timestamptz,
          idle_expires_at=LEAST($3::timestamptz, s.absolute_expires_at)
      FROM accounts AS a
      WHERE s.token_hash=$1
        AND a.id=s.account_id
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > $2::timestamptz
        AND s.absolute_expires_at > $2::timestamptz
      RETURNING
        s.id, s.account_id, s.token_hash, s.client_type, s.created_at, s.last_seen_at,
        s.idle_expires_at, s.absolute_expires_at, s.revoked_at,
        a.id AS account_id_value, a.role, a.email, a.display_name,
        a.password_salt, a.password_hash, a.created_at AS account_created_at`, [
      tokenHash,
      nowIso,
      proposedIdleExpiry,
    ]);
    const row = result.rows[0];
    if (!row) return undefined;
    const refreshed = rowToSession(row);
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

  async verifyPassword(password: string, account: Account | undefined): Promise<boolean> {
    return verifyPassword(password, account, this.passwordHasher);
  }
}

export function accountPublic(account: Account): AccountPublic {
  return { id: account.id, role: account.role, email: account.email, display_name: account.display_name };
}

export function normalizeAccountIdentity(email: string): string {
  return email.trim().toLowerCase();
}

export function validateSigninCredentials(email: string, password: string): string {
  const normalizedEmail = normalizeAccountIdentity(email);
  if (!normalizedEmail.includes("@") || normalizedEmail.length < 5 || normalizedEmail.length > MAX_EMAIL_LENGTH) {
    throw new Error("email_invalid");
  }
  if (!password) throw new Error("password_required");
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) throw new Error("password_too_long");
  return normalizedEmail;
}

/**
 * Always performs the same scrypt work, including for an unknown account, so
 * signin failures do not expose account existence through a cheap miss path.
 */
export async function verifyPassword(
  password: string,
  account: Account | undefined,
  passwordHasher: PasswordHasher = DEFAULT_PASSWORD_HASHER
): Promise<boolean> {
  const salt = account ? Buffer.from(account.password_salt, "base64url") : DUMMY_PASSWORD_SALT;
  const candidate = Buffer.from(await passwordHasher.derive(password, salt));
  const expected = Buffer.from(account?.password_hash ?? DUMMY_PASSWORD_HASH);
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return Boolean(account) && matches;
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

export function validateSignupCredentials(email: string, password: string, role: AccountRole, displayName: string): { email: string; displayName: string } {
  const normalizedEmail = validateSigninCredentials(email, password);
  const normalizedName = displayName.trim().replace(/\s+/g, " ");
  if (password.length < 8) throw new Error("password_too_short");
  if (role !== "user" && role !== "creator") throw new Error("role_invalid");
  if (!normalizedName) throw new Error("display_name_required");
  if (normalizedName.length > MAX_DISPLAY_NAME_LENGTH) throw new Error("display_name_too_long");
  return { email: normalizedEmail, displayName: normalizedName };
}

function accountId(role: AccountRole, displayName: string): string {
  // Account identity is an authority key, not a display-name handle. Names
  // remain presentation data and may change without changing creator URLs.
  void role;
  void displayName;
  return randomUUID();
}
function derivePasswordAsync(password: string, salt: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: 2 ** 14, r: 8, p: 1 }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey.toString("base64url"));
    });
  });
}
function integerEnvironmentSetting(environment: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = environment[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}
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
