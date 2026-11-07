import { randomBytes } from "node:crypto";
import type { Pool } from "pg";

export const CHANNEL_KINDS = ["telegram", "line", "lark", "imessage"] as const;
export type ChannelKind = typeof CHANNEL_KINDS[number];
export const CHANNEL_LABELS: Record<ChannelKind, string> = { telegram: "Telegram", line: "LINE", lark: "Lark", imessage: "iMessage" };

export type TaskButtonAction = "approve" | "decline";
/** A reply outside Studio. Adapters render buttons however their platform can; replyTo is the event's messageRef. */
export type OutboundMessage = { text: string; buttons?: Array<{ label: string; taskId: string; action: TaskButtonAction }>; replyTo?: string };

export type InboundFile = { ref: string; name: string; size?: number };
/** One thing that happened on a platform, in our terms. No text and no file means a type we can't read yet. */
export type InboundEvent = {
  eventId: string;
  peerId: string;
  text?: string;
  file?: InboundFile;
  messageRef?: string;
  button?: { taskId: string; action: TaskButtonAction; ref?: string };
};

/**
 * Port: one messaging platform. The Assistant knows nothing else about it.
 * Webhook platforms implement verify and parse; a platform that pushes over its
 * own connection implements listen instead.
 */
export interface ChannelAdapter {
  readonly kind: ChannelKind;
  /** Empty for our official account; the account id when the Expert brings their own app. */
  readonly scope: string;
  readonly maxFileBytes: number;
  available(): boolean;
  verify?(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
  /** respond is the body the platform expects, such as a URL challenge. */
  parse?(raw: Buffer): { events: InboundEvent[]; respond?: unknown };
  listen?(onEvents: (events: InboundEvent[]) => Promise<void>, signal: AbortSignal): Promise<void>;
  send(peerId: string, message: OutboundMessage): Promise<void>;
  download(file: InboundFile): Promise<Buffer>;
  /** Clear a pressed button, where the platform needs that. */
  acknowledge?(event: InboundEvent, text?: string): Promise<void>;
  /** How the Expert reaches us with this code: a link when the platform has one, otherwise the code is enough. */
  connectUrl(code: string): string | undefined;
  /** Opens the chat when no link can carry the code. */
  chatUrl?(): string;
}

/** Finds the adapter for a platform: our shared one, or the Expert's own app. */
export class ChannelHub {
  private shared = new Map<ChannelKind, ChannelAdapter>();
  constructor(adapters: ChannelAdapter[], private own: (kind: ChannelKind, accountId: string) => Promise<ChannelAdapter | undefined> = async () => undefined) {
    for (const adapter of adapters) this.shared.set(adapter.kind, adapter);
  }
  async get(kind: ChannelKind, accountId?: string): Promise<ChannelAdapter | undefined> {
    const adapter = this.shared.get(kind) ?? (accountId ? await this.own(kind, accountId) : undefined);
    return adapter?.available() ? adapter : undefined;
  }
  /** Platforms an Expert can connect to right now without bringing anything. */
  sharedKinds(): ChannelKind[] { return [...this.shared.values()].filter(adapter => adapter.available()).map(adapter => adapter.kind); }
  listeners(): ChannelAdapter[] { return [...this.shared.values()].filter(adapter => adapter.available() && adapter.listen); }
}

export type ChannelLink = { kind: ChannelKind; peerId?: string; hasCredentials: boolean; lastEventAt?: string };

/** Port: which account each platform peer belongs to. */
export interface ChannelLinks {
  issueCode(accountId: string, kind: ChannelKind, now?: Date): Promise<string>;
  /** Bind this peer to the account that issued the code. The peer moves away from any earlier account. */
  redeem(kind: ChannelKind, scope: string, code: string, peerId: string, now?: Date): Promise<string | undefined>;
  accountFor(kind: ChannelKind, scope: string, peerId: string): Promise<string | undefined>;
  peer(accountId: string, kind: ChannelKind): Promise<string | undefined>;
  list(accountId: string): Promise<ChannelLink[]>;
  touch(accountId: string, kind: ChannelKind): Promise<void>;
  unlink(accountId: string, kind: ChannelKind): Promise<void>;
  saveCredentials(accountId: string, kind: ChannelKind, sealed: string): Promise<void>;
  credentials(accountId: string, kind: ChannelKind): Promise<string | undefined>;
}

const LINK_CODE_MS = 15 * 60_000;
/** No lookalikes: Experts may retype this. */
function newLinkCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return `HATCH-${[...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join("")}`;
}
export const LINK_CODE_PATTERN = /HATCH-[A-Z0-9]{8}/;

export class PostgresChannelLinks implements ChannelLinks {
  private constructor(private pool: Pool, private scopeOf: (accountId: string, kind: ChannelKind) => string) {}
  static async open(pool: Pool, scopeOf: (accountId: string, kind: ChannelKind) => string): Promise<PostgresChannelLinks> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_assistant_channels (
        account_id UUID NOT NULL,
        kind TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        peer_id TEXT,
        link_code TEXT,
        link_expires_at TIMESTAMPTZ,
        credentials TEXT,
        last_event_at TIMESTAMPTZ,
        PRIMARY KEY (account_id, kind)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_assistant_channels_peer_idx ON hatch_assistant_channels (kind, scope, peer_id) WHERE peer_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_assistant_channels_code_idx ON hatch_assistant_channels (link_code) WHERE link_code IS NOT NULL;
    `);
    return new PostgresChannelLinks(pool, scopeOf);
  }
  async issueCode(accountId: string, kind: ChannelKind, now = new Date()): Promise<string> {
    const code = newLinkCode();
    await this.pool.query(`INSERT INTO hatch_assistant_channels (account_id, kind, scope, link_code, link_expires_at) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (account_id, kind) DO UPDATE SET scope = $3, link_code = $4, link_expires_at = $5`, [accountId, kind, this.scopeOf(accountId, kind), code, new Date(now.getTime() + LINK_CODE_MS)]);
    return code;
  }
  async redeem(kind: ChannelKind, scope: string, code: string, peerId: string, now = new Date()): Promise<string | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const row = (await client.query("SELECT account_id FROM hatch_assistant_channels WHERE link_code = $1 AND kind = $2 AND scope = $3 AND link_expires_at > $4 FOR UPDATE", [code, kind, scope, now])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return undefined; }
      await client.query("UPDATE hatch_assistant_channels SET peer_id = NULL WHERE kind = $1 AND scope = $2 AND peer_id = $3", [kind, scope, peerId]);
      await client.query("UPDATE hatch_assistant_channels SET peer_id = $3, link_code = NULL, link_expires_at = NULL, last_event_at = $4 WHERE account_id = $1 AND kind = $2", [row.account_id, kind, peerId, now]);
      await client.query("COMMIT");
      return row.account_id;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
  async accountFor(kind: ChannelKind, scope: string, peerId: string): Promise<string | undefined> {
    return (await this.pool.query("SELECT account_id FROM hatch_assistant_channels WHERE kind = $1 AND scope = $2 AND peer_id = $3", [kind, scope, peerId])).rows[0]?.account_id;
  }
  async peer(accountId: string, kind: ChannelKind): Promise<string | undefined> {
    return (await this.pool.query("SELECT peer_id FROM hatch_assistant_channels WHERE account_id = $1 AND kind = $2", [accountId, kind])).rows[0]?.peer_id ?? undefined;
  }
  async list(accountId: string): Promise<ChannelLink[]> {
    return (await this.pool.query("SELECT kind, peer_id, credentials, last_event_at FROM hatch_assistant_channels WHERE account_id = $1", [accountId])).rows.map(row => ({
      kind: row.kind, hasCredentials: Boolean(row.credentials), ...(row.peer_id ? { peerId: row.peer_id } : {}), ...(row.last_event_at ? { lastEventAt: new Date(row.last_event_at).toISOString() } : {}),
    }));
  }
  async touch(accountId: string, kind: ChannelKind): Promise<void> { await this.pool.query("UPDATE hatch_assistant_channels SET last_event_at = NOW() WHERE account_id = $1 AND kind = $2", [accountId, kind]); }
  async unlink(accountId: string, kind: ChannelKind): Promise<void> { await this.pool.query("UPDATE hatch_assistant_channels SET peer_id = NULL, link_code = NULL WHERE account_id = $1 AND kind = $2", [accountId, kind]); }
  async saveCredentials(accountId: string, kind: ChannelKind, sealed: string): Promise<void> {
    await this.pool.query(`INSERT INTO hatch_assistant_channels (account_id, kind, scope, credentials) VALUES ($1, $2, $3, $4)
      ON CONFLICT (account_id, kind) DO UPDATE SET credentials = $4, scope = $3`, [accountId, kind, this.scopeOf(accountId, kind), sealed]);
  }
  async credentials(accountId: string, kind: ChannelKind): Promise<string | undefined> {
    return (await this.pool.query("SELECT credentials FROM hatch_assistant_channels WHERE account_id = $1 AND kind = $2", [accountId, kind])).rows[0]?.credentials ?? undefined;
  }
}

/** Explicit test dependency; the product never constructs this. */
export class MemoryChannelLinks implements ChannelLinks {
  readonly rows = new Map<string, { accountId: string; kind: ChannelKind; peerId?: string; code?: string; expiresAt?: number; credentials?: string; lastEventAt?: string }>();
  private row(accountId: string, kind: ChannelKind) { const key = `${accountId}:${kind}`; let row = this.rows.get(key); if (!row) { row = { accountId, kind }; this.rows.set(key, row); } return row; }
  link(accountId: string, kind: ChannelKind, peerId: string): void { this.row(accountId, kind).peerId = peerId; }
  async issueCode(accountId: string, kind: ChannelKind, now = new Date()) { const code = newLinkCode(); Object.assign(this.row(accountId, kind), { code, expiresAt: now.getTime() + LINK_CODE_MS }); return code; }
  async redeem(kind: ChannelKind, _scope: string, code: string, peerId: string, now = new Date()) {
    const row = [...this.rows.values()].find(candidate => candidate.kind === kind && candidate.code === code && (candidate.expiresAt ?? 0) > now.getTime());
    if (!row) return undefined;
    for (const other of this.rows.values()) if (other.kind === kind && other.peerId === peerId) delete other.peerId;
    Object.assign(row, { peerId, code: undefined, expiresAt: undefined });
    return row.accountId;
  }
  async accountFor(kind: ChannelKind, _scope: string, peerId: string) { return [...this.rows.values()].find(row => row.kind === kind && row.peerId === peerId)?.accountId; }
  async peer(accountId: string, kind: ChannelKind) { return this.rows.get(`${accountId}:${kind}`)?.peerId; }
  async list(accountId: string) { return [...this.rows.values()].filter(row => row.accountId === accountId).map(row => ({ kind: row.kind, hasCredentials: Boolean(row.credentials), ...(row.peerId ? { peerId: row.peerId } : {}), ...(row.lastEventAt ? { lastEventAt: row.lastEventAt } : {}) })); }
  async touch(accountId: string, kind: ChannelKind) { this.row(accountId, kind).lastEventAt = new Date().toISOString(); }
  async unlink(accountId: string, kind: ChannelKind) { const row = this.row(accountId, kind); delete row.peerId; delete row.code; }
  async saveCredentials(accountId: string, kind: ChannelKind, sealed: string) { this.row(accountId, kind).credentials = sealed; }
  async credentials(accountId: string, kind: ChannelKind) { return this.rows.get(`${accountId}:${kind}`)?.credentials; }
}

/** Account-level facts the Assistant's schedule needs. Stored on accounts. */
export class AccountReach {
  constructor(private pool: Pool) {}
  async ensureSchema(): Promise<void> { await this.pool.query("ALTER TABLE accounts ADD COLUMN IF NOT EXISTS timezone TEXT"); }
  async timezone(accountId: string): Promise<string> {
    return (await this.pool.query("SELECT timezone FROM accounts WHERE id = $1", [accountId])).rows[0]?.timezone || "UTC";
  }
  async setTimezone(accountId: string, timezone: string): Promise<void> {
    if (!validTimezone(timezone)) return;
    await this.pool.query("UPDATE accounts SET timezone = $2 WHERE id = $1 AND timezone IS DISTINCT FROM $2", [accountId, timezone]);
  }
  /** Accounts that own at least one active Product: the ones whose Assistant runs the daily check. */
  async assistantAccounts(): Promise<Array<{ accountId: string; timezone: string }>> {
    return (await this.pool.query(`
      SELECT a.id, a.timezone FROM accounts a
      WHERE EXISTS (SELECT 1 FROM hatch_creator_products p WHERE p.creator_id = a.id::text AND p.status = 'active')
    `)).rows.map(row => ({ accountId: row.id, timezone: row.timezone || "UTC" }));
  }
}

export function validTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return value.length <= 64; } catch { return false; }
}

export function localHour(timezone: string, now: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", hourCycle: "h23" }).format(now));
}

export function localDate(timezone: string, now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
