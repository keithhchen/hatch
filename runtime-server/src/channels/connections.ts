import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AgentTarget, Audience, Connection, ConnectionState, Principal } from "../surfaces/contract.js";
import type { ChannelKind } from "./types.js";

/** A Connection as the channel layer holds it. `scope` is the platform tenant it was authorized on: empty for our shared account. */
export type ChannelConnection = Connection & { scope: string };
/** A sender known to a Connection: the Expert who linked, a member, or a contact who wrote in. `threadId` is where they were reached last. */
export type Identity = { id: string; connectionId: string; senderId: string; threadId: string };
export type OwnedConnection = ChannelConnection & { linked: boolean; hasCredentials: boolean; lastEventAt?: string; /** Who is bound, as the platform names them. */ senderId?: string; /** A `public` Connection's unguessable deep-link payload: `t.me/<bot>?start=<startCode>` meets anyone as its contact, also on a shared bot. */ startCode?: string };
export type Resolved = { connection: ChannelConnection; identity?: Identity };

const LINK_CODE_MS = 15 * 60_000;
/** No lookalikes: Experts may retype this. */
function newLinkCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return `HATCH-${[...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join("")}`;
}
export const LINK_CODE_PATTERN = /HATCH-[A-Z0-9]{8}/;
export const START_CODE_PATTERN = /^[0-9a-f]{32}$/;

export const targetKey = (target: Connection["target"]): string => target.kind === "assistant" ? "assistant" : `product:${target.productId}`;
/** Studio's own entry is the Assistant, which works across the account's Products. A Product's Chat is bound per Product. */
export const STUDIO_TARGET: AgentTarget = { kind: "assistant" };

/** The Assistant manages Studio, so only its owner may reach it: a Connection that is not `self` can only point at a Product. */
export function assertReachable(connection: Pick<Connection, "audience" | "target">): void {
  if (connection.target.kind === "assistant" && connection.audience !== "self") throw new Error("Only a self Connection can reach the Assistant");
}

/** `self` acts as its owner. Everyone else is a contact, isolated by Connection and contact. */
export function principalFor(connection: ChannelConnection, identity: Identity): Principal {
  return connection.audience === "self"
    ? { kind: "account", accountId: connection.ownerAccountId }
    : { kind: "contact", connectionId: connection.id, contactId: identity.id };
}

/** Port: who each platform sender is, and which Agent answers them. */
export interface ConnectionRepository {
  /** A one-time code the owner sends from the platform, to bind their chat to the Assistant (Studio) or to one of their Products (Chat). The self Connection is created on the first call. */
  issueCode(ownerAccountId: string, channel: ChannelKind, target?: AgentTarget, now?: Date): Promise<string>;
  /** Bind the sender to the Connection that issued the code. The sender moves away from any earlier Connection. */
  redeem(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }, now?: Date): Promise<ChannelConnection | undefined>;
  /**
   * Which Connection a sender on a platform tenant belongs to. One endpoint can serve many tenants, so this runs per event.
   * A sender we know resolves through their identity. An unknown sender resolves to the tenant's own Connection, if it has one.
   */
  resolveConnection(payload: { channel: ChannelKind; scope: string; senderId: string }): Promise<Resolved | undefined>;
  /** A contact writes in to a `public` Connection: remember them. */
  meet(connection: ChannelConnection, who: { senderId: string; threadId: string }): Promise<Identity>;
  /** A sender arrives by a `public` Connection's start code: they become its contact. Undefined when no such Connection takes them. */
  meetByStartCode(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }): Promise<{ connection: ChannelConnection; identity: Identity } | undefined>;
  /** The Assistant Connections the account owns that someone is linked to, most recently active first: where the Assistant reaches them. */
  linked(ownerAccountId: string): Promise<Resolved[]>;
  /** Every Connection the account owns, linked or not, with what Studio shows of it. */
  owned(ownerAccountId: string): Promise<OwnedConnection[]>;
  get(id: string): Promise<ChannelConnection | undefined>;
  touch(id: string): Promise<void>;
  /** `degraded` only from `active`; back to `active` only from `degraded`. A revoked Connection stays revoked. */
  setState(id: string, state: Exclude<ConnectionState, "revoked">): Promise<void>;
  /** The account unbinds its self Connection to `target`: nobody is linked and nothing is processed. Credentials stay, sealed, for a later link. */
  revoke(ownerAccountId: string, channel: ChannelKind, target?: AgentTarget): Promise<void>;
  /** `scope` names the platform tenant the credentials belong to, where that is known only from them (a Slack workspace, a Page). */
  saveCredentials(ownerAccountId: string, channel: ChannelKind, sealed: string, scope?: string): Promise<void>;
  credentials(ownerAccountId: string, channel: ChannelKind): Promise<string | undefined>;
  /** The sealed credentials of a platform tenant on a shared app, whoever owns its Connection. Absent once access is revoked. */
  credentialsOf(channel: ChannelKind, scope: string): Promise<string | undefined>;
  /** Who a still-valid link code was issued to, for a platform's install redirect that carries it as `state`. */
  ownerOfCode(channel: ChannelKind, code: string, now?: Date): Promise<string | undefined>;
  /** The platform took a tenant's access away: its Connections are revoked, nobody stays linked, and its credentials are dropped. */
  revokeTenant(channel: ChannelKind, scope: string): Promise<void>;
  /** Tenants that bring their own app: Connections holding credentials that are not revoked. */
  listening(): Promise<Array<{ ownerAccountId: string; channel: ChannelKind; scope: string }>>;
}

const COLUMNS = "id, owner_account_id, channel, scope, client, target, audience, task_specific, state";
const IDENTITY_COLUMNS = "i.id AS identity_id, i.sender_id, i.thread_id";
const connectionOf = (row: Record<string, any>): ChannelConnection => ({
  id: row.id, ownerAccountId: row.owner_account_id, channel: row.channel, scope: row.scope, client: row.client, target: row.target, audience: row.audience as Audience, taskSpecific: row.task_specific, state: row.state as ConnectionState,
});
const identityOf = (row: Record<string, any>): Identity => ({ id: row.identity_id ?? row.id, connectionId: row.connection_id ?? row.id, senderId: row.sender_id, threadId: row.thread_id });

export class PostgresConnections implements ConnectionRepository {
  private constructor(private pool: Pool, private scopeOf: (ownerAccountId: string, channel: ChannelKind) => string) {}

  /** Creates the schema, then moves the old per-account channel rows over once. That table is read nowhere else. */
  static async open(pool: Pool, scopeOf: (ownerAccountId: string, channel: ChannelKind) => string): Promise<PostgresConnections> {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_connections (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id UUID NOT NULL,
        channel TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        client TEXT NOT NULL DEFAULT 'im' CHECK (client IN ('im', 'dm')),
        target JSONB NOT NULL,
        target_key TEXT NOT NULL,
        audience TEXT NOT NULL CHECK (audience IN ('self', 'org', 'public')),
        task_specific BOOLEAN NOT NULL DEFAULT false,
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'degraded', 'revoked')),
        credentials TEXT,
        link_code TEXT,
        link_expires_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (audience = 'self' OR target_key <> 'assistant'),
        UNIQUE (owner_account_id, channel, audience, target_key)
      );
      ALTER TABLE hatch_connections ADD COLUMN IF NOT EXISTS task_specific BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE hatch_connections ADD COLUMN IF NOT EXISTS start_code TEXT NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', '');
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_connections_start_code_idx ON hatch_connections (start_code);
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_connections_code_idx ON hatch_connections (link_code) WHERE link_code IS NOT NULL;
      CREATE INDEX IF NOT EXISTS hatch_connections_scope_idx ON hatch_connections (channel, scope) WHERE scope <> '';
      CREATE TABLE IF NOT EXISTS hatch_channel_identities (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        connection_id UUID NOT NULL REFERENCES hatch_connections (id) ON DELETE CASCADE,
        channel TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT '',
        sender_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        UNIQUE (channel, scope, sender_id)
      );
      CREATE INDEX IF NOT EXISTS hatch_channel_identities_connection_idx ON hatch_channel_identities (connection_id);
    `);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One migration at a time; a second process finds the old table already renamed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hatch_connections_migration'))");
      if ((await client.query("SELECT to_regclass('hatch_assistant_channels') AS old")).rows[0].old) {
        await client.query(`
          INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience, credentials, link_code, link_expires_at, last_event_at)
          SELECT account_id, kind, scope, '{"kind":"assistant"}'::jsonb, 'assistant', 'self', credentials, link_code, link_expires_at, last_event_at FROM hatch_assistant_channels
          ON CONFLICT DO NOTHING;
          INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id)
          SELECT c.id, o.kind, o.scope, o.peer_id, o.peer_id FROM hatch_assistant_channels o
          JOIN hatch_connections c ON c.owner_account_id = o.account_id AND c.channel = o.kind AND c.audience = 'self' AND c.target_key = 'assistant'
          WHERE o.peer_id IS NOT NULL
          ON CONFLICT DO NOTHING;
          ALTER TABLE hatch_assistant_channels RENAME TO hatch_assistant_channels_migrated;
        `);
      }
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
    return new PostgresConnections(pool, scopeOf);
  }

  async issueCode(ownerAccountId: string, channel: ChannelKind, target: AgentTarget = STUDIO_TARGET, now = new Date()): Promise<string> {
    const code = newLinkCode();
    await this.pool.query(`INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience, link_code, link_expires_at)
      VALUES ($1, $2, $3, $6, $7, 'self', $4, $5)
      ON CONFLICT (owner_account_id, channel, audience, target_key) DO UPDATE SET scope = CASE WHEN hatch_connections.credentials IS NOT NULL THEN hatch_connections.scope ELSE $3 END, link_code = $4, link_expires_at = $5`,
    [ownerAccountId, channel, this.scopeOf(ownerAccountId, channel), code, new Date(now.getTime() + LINK_CODE_MS), JSON.stringify(target), targetKey(target)]);
    return code;
  }

  async redeem(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }, now = new Date()): Promise<ChannelConnection | undefined> {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE link_code = $1 AND channel = $2 AND scope = $3 AND link_expires_at > $4 FOR UPDATE`, [code, channel, scope, now])).rows[0];
      if (!row) return undefined;
      const connection = connectionOf(row);
      // The sender moves away from any earlier Connection. A self Connection has one sender: the new one replaces the old.
      await client.query("DELETE FROM hatch_channel_identities WHERE channel = $1 AND scope = $2 AND sender_id = $3", [channel, scope, who.senderId]);
      if (connection.audience === "self") await client.query("DELETE FROM hatch_channel_identities WHERE connection_id = $1", [connection.id]);
      await client.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, $2, $3, $4, $5)", [connection.id, channel, scope, who.senderId, who.threadId]);
      await client.query("UPDATE hatch_connections SET link_code = NULL, link_expires_at = NULL, state = 'active', last_event_at = $2 WHERE id = $1", [connection.id, now]);
      return { ...connection, state: "active" as const };
    });
  }

  async resolveConnection(payload: { channel: ChannelKind; scope: string; senderId: string }): Promise<Resolved | undefined> {
    const known = (await this.pool.query(`SELECT c.id, c.owner_account_id, c.channel, c.scope, c.client, c.target, c.audience, c.task_specific, c.state, ${IDENTITY_COLUMNS}
      FROM hatch_channel_identities i JOIN hatch_connections c ON c.id = i.connection_id
      WHERE i.channel = $1 AND i.scope = $2 AND i.sender_id = $3 AND c.state <> 'revoked'`, [payload.channel, payload.scope, payload.senderId])).rows[0];
    if (known) return { connection: connectionOf(known), identity: { id: known.identity_id, connectionId: known.id, senderId: known.sender_id, threadId: known.thread_id } };
    if (!payload.scope) return undefined;
    const tenant = (await this.pool.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE channel = $1 AND scope = $2 AND state <> 'revoked' ORDER BY (audience = 'public') DESC, created_at LIMIT 1`, [payload.channel, payload.scope])).rows[0];
    return tenant ? { connection: connectionOf(tenant) } : undefined;
  }

  async meet(connection: ChannelConnection, who: { senderId: string; threadId: string }): Promise<Identity> {
    const row = (await this.pool.query(`INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (channel, scope, sender_id) DO UPDATE SET thread_id = EXCLUDED.thread_id WHERE hatch_channel_identities.connection_id = EXCLUDED.connection_id
      RETURNING id, connection_id, sender_id, thread_id`, [connection.id, connection.channel, connection.scope, who.senderId, who.threadId])).rows[0];
    // The sender already belongs to another Connection: a contact is never shared between them.
    if (!row) throw new Error("This sender belongs to another Connection");
    return identityOf(row);
  }

  async meetByStartCode(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }): Promise<{ connection: ChannelConnection; identity: Identity } | undefined> {
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE start_code = $1 AND channel = $2 AND scope = $3 AND audience = 'public' AND state <> 'revoked'`, [code, channel, scope])).rows[0];
    if (!row) return undefined;
    const connection = connectionOf(row);
    return { connection, identity: await this.meet(connection, who) };
  }

  async linked(ownerAccountId: string): Promise<Resolved[]> {
    const rows = (await this.pool.query(`SELECT c.id, c.owner_account_id, c.channel, c.scope, c.client, c.target, c.audience, c.task_specific, c.state, ${IDENTITY_COLUMNS}
      FROM hatch_connections c JOIN hatch_channel_identities i ON i.connection_id = c.id
      WHERE c.owner_account_id = $1 AND c.audience = 'self' AND c.target_key = 'assistant' AND c.state <> 'revoked' ORDER BY c.last_event_at DESC NULLS LAST`, [ownerAccountId])).rows;
    return rows.map(row => ({ connection: connectionOf(row), identity: { id: row.identity_id, connectionId: row.id, senderId: row.sender_id, threadId: row.thread_id } }));
  }

  async owned(ownerAccountId: string): Promise<OwnedConnection[]> {
    return (await this.pool.query(`SELECT ${COLUMNS}, credentials IS NOT NULL AS has_credentials, last_event_at, start_code, EXISTS (SELECT 1 FROM hatch_channel_identities i WHERE i.connection_id = c.id) AS linked,
      (SELECT i.sender_id FROM hatch_channel_identities i WHERE i.connection_id = c.id LIMIT 1) AS sender_id
      FROM hatch_connections c WHERE owner_account_id = $1 ORDER BY created_at`, [ownerAccountId])).rows.map(row => ({
      ...connectionOf(row), linked: row.linked, hasCredentials: row.has_credentials, ...(row.sender_id ? { senderId: row.sender_id } : {}), ...(row.last_event_at ? { lastEventAt: new Date(row.last_event_at).toISOString() } : {}),
      ...(row.audience === "public" ? { startCode: row.start_code } : {}),
    }));
  }

  async get(id: string): Promise<ChannelConnection | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE id = $1`, [id])).rows[0];
    return row && connectionOf(row);
  }

  async touch(id: string): Promise<void> { await this.pool.query("UPDATE hatch_connections SET last_event_at = now() WHERE id = $1", [id]); }

  async setState(id: string, state: Exclude<ConnectionState, "revoked">): Promise<void> {
    await this.pool.query("UPDATE hatch_connections SET state = $2 WHERE id = $1 AND state = $3", [id, state, state === "degraded" ? "active" : "degraded"]);
  }

  async revoke(ownerAccountId: string, channel: ChannelKind, target: AgentTarget = STUDIO_TARGET): Promise<void> {
    await this.transaction(async client => {
      const ids = (await client.query("UPDATE hatch_connections SET state = 'revoked', link_code = NULL, link_expires_at = NULL WHERE owner_account_id = $1 AND channel = $2 AND audience = 'self' AND target_key = $3 RETURNING id", [ownerAccountId, channel, targetKey(target)])).rows.map(row => row.id);
      await client.query("DELETE FROM hatch_channel_identities WHERE connection_id = ANY($1::uuid[])", [ids]);
    });
  }

  async saveCredentials(ownerAccountId: string, channel: ChannelKind, sealed: string, scope = this.scopeOf(ownerAccountId, channel)): Promise<void> {
    await this.pool.query(`INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience, credentials)
      VALUES ($1, $2, $3, '{"kind":"assistant"}', 'assistant', 'self', $4)
      ON CONFLICT (owner_account_id, channel, audience, target_key) DO UPDATE SET credentials = $4, scope = $3`, [ownerAccountId, channel, scope, sealed]);
  }

  async credentials(ownerAccountId: string, channel: ChannelKind): Promise<string | undefined> {
    return (await this.pool.query("SELECT credentials FROM hatch_connections WHERE owner_account_id = $1 AND channel = $2 AND audience = 'self' AND target_key = 'assistant'", [ownerAccountId, channel])).rows[0]?.credentials ?? undefined;
  }

  async credentialsOf(channel: ChannelKind, scope: string): Promise<string | undefined> {
    if (!scope) return undefined;
    return (await this.pool.query("SELECT credentials FROM hatch_connections WHERE channel = $1 AND scope = $2 AND credentials IS NOT NULL AND state <> 'revoked' ORDER BY created_at LIMIT 1", [channel, scope])).rows[0]?.credentials ?? undefined;
  }

  async ownerOfCode(channel: ChannelKind, code: string, now = new Date()): Promise<string | undefined> {
    return (await this.pool.query("SELECT owner_account_id FROM hatch_connections WHERE channel = $1 AND link_code = $2 AND link_expires_at > $3", [channel, code, now])).rows[0]?.owner_account_id ?? undefined;
  }

  async revokeTenant(channel: ChannelKind, scope: string): Promise<void> {
    if (!scope) return;
    await this.transaction(async client => {
      const ids = (await client.query("UPDATE hatch_connections SET state = 'revoked', credentials = NULL, link_code = NULL, link_expires_at = NULL WHERE channel = $1 AND scope = $2 RETURNING id", [channel, scope])).rows.map(row => row.id);
      await client.query("DELETE FROM hatch_channel_identities WHERE connection_id = ANY($1::uuid[])", [ids]);
    });
  }

  async listening(): Promise<Array<{ ownerAccountId: string; channel: ChannelKind; scope: string }>> {
    return (await this.pool.query("SELECT DISTINCT owner_account_id, channel, scope FROM hatch_connections WHERE credentials IS NOT NULL AND state <> 'revoked'")).rows
      .map(row => ({ ownerAccountId: row.owner_account_id, channel: row.channel, scope: row.scope }));
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; } finally { client.release(); }
  }
}
