import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";

export type AccountRole = "user" | "creator";
export type Account = { id: string; role: AccountRole; email: string; display_name: string; password_salt: string; password_hash: string; created_at: string };
export type AccountPublic = Pick<Account, "id" | "role" | "email" | "display_name">;

export class AccountStoreTs {
  private readonly accounts = new Map<string, Account>();

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
    )`);
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
  return slug || `${role}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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
