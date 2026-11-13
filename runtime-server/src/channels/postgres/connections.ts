import type { Pool, PoolClient } from "pg";
import type { AgentTarget, Audience, ConnectionState } from "../../surfaces/contract.js";
import { newLinkCode, STUDIO_TARGET, targetKey, type ChannelConnection, type ConnectionRepository, type Identity, type Linked, type OwnedConnection, type Resolved, GLOBAL_USER_ID_CHANNELS } from "../connections.js";
import type { ChannelKind, SenderProfile } from "../types.js";

const LINK_CODE_MS = 15 * 60_000;
/** The rows that count as the live Connection of an owner to a target: a Product's dormant bots (no credentials) are kept beside it. */
const ACTIVE = "WHERE credentials IS NOT NULL OR audience <> 'public'";

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
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'degraded')),
        credentials TEXT,
        link_code TEXT,
        link_expires_at TIMESTAMPTZ,
        last_event_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        CHECK (audience = 'self' OR target_key <> 'assistant')
      );
      -- Once a table-level UNIQUE (owner, channel, audience, target_key). A Product keeps one row for each bot it has had, so only the live ones are unique: see ACTIVE.
      DO $$ DECLARE name text; BEGIN
        FOR name IN SELECT conname FROM pg_constraint WHERE conrelid = 'hatch_connections'::regclass AND contype = 'u' LOOP EXECUTE format('ALTER TABLE hatch_connections DROP CONSTRAINT %I', name); END LOOP;
      END $$;
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_connections_active_idx ON hatch_connections (owner_account_id, channel, audience, target_key) WHERE credentials IS NOT NULL OR audience <> 'public';
      -- A bot is one Connection, whichever Product or account holds it.
      CREATE UNIQUE INDEX IF NOT EXISTS hatch_connections_bot_idx ON hatch_connections (channel, scope) WHERE audience = 'public' AND scope <> '';
      ALTER TABLE hatch_connections ADD COLUMN IF NOT EXISTS task_specific BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE hatch_connections DROP COLUMN IF EXISTS start_code;
      ALTER TABLE hatch_connections ADD COLUMN IF NOT EXISTS redeemed_by TEXT;
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
      -- Rows that an earlier version stored as role 'guest' stay in place and are never read: only 'owner' rows are admitted.
      ALTER TABLE hatch_channel_identities ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'guest'));
      -- The person behind a platform user, across every Connection that met them. Only Hatch reads it; contacts stay isolated per Connection.
      CREATE TABLE IF NOT EXISTS hatch_channel_people (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        display_name TEXT,
        username TEXT,
        language TEXT,
        first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        account_id UUID,
        UNIQUE (channel, platform_user_id)
      );
      ALTER TABLE hatch_channel_identities ADD COLUMN IF NOT EXISTS person_id UUID REFERENCES hatch_channel_people (id);
      -- Idempotent backfill: contacts met before people were recorded, on the platforms where the sender id is a global user id.
      INSERT INTO hatch_channel_people (channel, platform_user_id)
        SELECT DISTINCT i.channel, i.sender_id FROM hatch_channel_identities i JOIN hatch_connections c ON c.id = i.connection_id
        WHERE i.person_id IS NULL AND c.audience <> 'self' AND i.channel IN (${[...GLOBAL_USER_ID_CHANNELS].map(channel => `'${channel}'`).join(", ")})
        ON CONFLICT (channel, platform_user_id) DO NOTHING;
      UPDATE hatch_channel_identities i SET person_id = p.id FROM hatch_channel_people p, hatch_connections c
        WHERE i.person_id IS NULL AND c.id = i.connection_id AND c.audience <> 'self' AND p.channel = i.channel AND p.platform_user_id = i.sender_id;
    `);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // One migration at a time; a second process finds the old table already renamed.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('hatch_connections_migration'))");
      // A revoked Connection is gone: unbinding deletes it now. What older versions left behind goes, and `revoked` with it.
      await client.query(`
        DELETE FROM hatch_connections WHERE state = 'revoked';
        DO $$ BEGIN
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'hatch_connections'::regclass AND conname = 'hatch_connections_state_check' AND pg_get_constraintdef(oid) LIKE '%revoked%') THEN
            ALTER TABLE hatch_connections DROP CONSTRAINT hatch_connections_state_check;
            ALTER TABLE hatch_connections ADD CONSTRAINT hatch_connections_state_check CHECK (state IN ('active', 'degraded'));
          END IF;
        END $$;
      `);
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
      ON CONFLICT (owner_account_id, channel, audience, target_key) ${ACTIVE} DO UPDATE SET scope = CASE WHEN hatch_connections.credentials IS NOT NULL THEN hatch_connections.scope ELSE $3 END, link_code = $4, link_expires_at = $5, redeemed_by = NULL`,
    [ownerAccountId, channel, this.scopeOf(ownerAccountId, channel), code, new Date(now.getTime() + LINK_CODE_MS), JSON.stringify(target), targetKey(target)]);
    return code;
  }

  async redeem(channel: ChannelKind, scope: string, code: string, who: { senderId: string; threadId: string }, now = new Date()): Promise<Linked | undefined> {
    return this.transaction(async client => {
      const row = (await client.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE link_code = $1 AND channel = $2 AND scope = $3 AND link_expires_at > $4 FOR UPDATE`, [code, channel, scope, now])).rows[0];
      // A code redeemed by this same sender is still theirs: asking again, as a retry of the event does, is the same success.
      if (!row) {
        const again = (await client.query(`SELECT ${COLUMNS} FROM hatch_connections c WHERE link_code = $1 AND channel = $2 AND scope = $3 AND redeemed_by = $4
          AND EXISTS (SELECT 1 FROM hatch_channel_identities i WHERE i.connection_id = c.id AND i.sender_id = $4)`, [code, channel, scope, who.senderId])).rows[0];
        return again && connectionOf(again);
      }
      const connection = connectionOf(row);
      // The sender moves away from any earlier Connection. A self Connection has one owner: the new one replaces the old.
      await client.query("DELETE FROM hatch_channel_identities WHERE channel = $1 AND scope = $2 AND sender_id = $3", [channel, scope, who.senderId]);
      if (connection.audience === "self") await client.query("DELETE FROM hatch_channel_identities WHERE connection_id = $1 AND role = 'owner'", [connection.id]);
      await client.query("INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id) VALUES ($1, $2, $3, $4, $5)", [connection.id, channel, scope, who.senderId, who.threadId]);
      await client.query("UPDATE hatch_connections SET link_expires_at = $2, redeemed_by = $3, state = 'active', last_event_at = $2 WHERE id = $1", [connection.id, now, who.senderId]);
      return { ...connection, state: "active" as const };
    });
  }

  async peekCode(channel: ChannelKind, scope: string, code: string, now = new Date()): Promise<{ ownerAccountId: string } | undefined> {
    const owner = (await this.pool.query("SELECT owner_account_id FROM hatch_connections WHERE channel = $1 AND scope = $2 AND link_code = $3 AND link_expires_at > $4", [channel, scope, code, now])).rows[0];
    return owner && { ownerAccountId: owner.owner_account_id };
  }

  async resolveConnection(payload: { channel: ChannelKind; scope: string; senderId: string }): Promise<Resolved | undefined> {
    const known = (await this.pool.query(`SELECT c.id, c.owner_account_id, c.channel, c.scope, c.client, c.target, c.audience, c.task_specific, c.state, ${IDENTITY_COLUMNS}
      FROM hatch_channel_identities i JOIN hatch_connections c ON c.id = i.connection_id
      WHERE i.channel = $1 AND i.scope = $2 AND i.sender_id = $3 AND i.role = 'owner'`, [payload.channel, payload.scope, payload.senderId])).rows[0];
    if (known) return { connection: connectionOf(known), identity: identityOf(known) };
    if (!payload.scope) return undefined;
    const tenant = (await this.pool.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE channel = $1 AND scope = $2 ORDER BY (audience = 'public') DESC, created_at LIMIT 1`, [payload.channel, payload.scope])).rows[0];
    return tenant ? { connection: connectionOf(tenant) } : undefined;
  }

  /** The person a platform user is, made on first sight. Name, username and language follow the platform; an hour of silence also counts as a visit. */
  private async person(channel: string, platformUserId: string, profile: SenderProfile = {}): Promise<string | null> {
    if (!GLOBAL_USER_ID_CHANNELS.has(channel as ChannelKind)) return null;
    const row = (await this.pool.query(`
      WITH seen AS (
        INSERT INTO hatch_channel_people (channel, platform_user_id, display_name, username, language) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (channel, platform_user_id) DO UPDATE SET
          display_name = COALESCE(EXCLUDED.display_name, hatch_channel_people.display_name),
          username = COALESCE(EXCLUDED.username, hatch_channel_people.username),
          language = COALESCE(EXCLUDED.language, hatch_channel_people.language),
          last_seen_at = now()
        WHERE (EXCLUDED.display_name IS NOT NULL AND EXCLUDED.display_name IS DISTINCT FROM hatch_channel_people.display_name)
           OR (EXCLUDED.username IS NOT NULL AND EXCLUDED.username IS DISTINCT FROM hatch_channel_people.username)
           OR (EXCLUDED.language IS NOT NULL AND EXCLUDED.language IS DISTINCT FROM hatch_channel_people.language)
           OR hatch_channel_people.last_seen_at < now() - interval '1 hour'
        RETURNING id
      )
      SELECT id FROM seen UNION ALL SELECT id FROM hatch_channel_people WHERE channel = $1 AND platform_user_id = $2 LIMIT 1
    `, [channel, platformUserId, profile.name ?? null, profile.username?.replace(/^@/, "") ?? null, profile.language ?? null])).rows[0];
    return row.id;
  }

  async recognize(connection: ChannelConnection, who: { senderId: string; profile?: SenderProfile }): Promise<void> {
    const personId = await this.person(connection.channel, who.senderId, who.profile);
    if (personId) await this.pool.query("UPDATE hatch_channel_identities SET person_id = $4 WHERE channel = $1 AND scope = $2 AND sender_id = $3 AND person_id IS NULL", [connection.channel, connection.scope, who.senderId, personId]);
  }

  async linkAccount(channel: ChannelKind, platformUserId: string, accountId: string): Promise<boolean> {
    const result = await this.pool.query(`INSERT INTO hatch_channel_people (channel, platform_user_id, account_id) VALUES ($1, $2, $3)
      ON CONFLICT (channel, platform_user_id) DO UPDATE SET account_id = EXCLUDED.account_id WHERE hatch_channel_people.account_id IS NULL OR hatch_channel_people.account_id = EXCLUDED.account_id
      RETURNING id`, [channel, platformUserId, accountId]);
    return result.rowCount === 1;
  }

  async meet(connection: ChannelConnection, who: { senderId: string; threadId: string; profile?: SenderProfile }): Promise<Identity> {
    const personId = await this.person(connection.channel, who.senderId, who.profile);
    const row = (await this.pool.query(`INSERT INTO hatch_channel_identities (connection_id, channel, scope, sender_id, thread_id, person_id) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (channel, scope, sender_id) DO UPDATE SET thread_id = EXCLUDED.thread_id, person_id = COALESCE(hatch_channel_identities.person_id, EXCLUDED.person_id) WHERE hatch_channel_identities.connection_id = EXCLUDED.connection_id
      RETURNING id, connection_id, sender_id, thread_id`, [connection.id, connection.channel, connection.scope, who.senderId, who.threadId, personId])).rows[0];
    // The sender already belongs to another Connection: a contact is never shared between them.
    if (!row) throw new Error("This sender belongs to another Connection");
    return identityOf(row);
  }

  async linked(ownerAccountId: string): Promise<Resolved[]> {
    const rows = (await this.pool.query(`SELECT c.id, c.owner_account_id, c.channel, c.scope, c.client, c.target, c.audience, c.task_specific, c.state, ${IDENTITY_COLUMNS}
      FROM hatch_connections c JOIN hatch_channel_identities i ON i.connection_id = c.id
      WHERE c.owner_account_id = $1 AND c.audience = 'self' AND c.target_key = 'assistant' AND i.role = 'owner' ORDER BY c.last_event_at DESC NULLS LAST`, [ownerAccountId])).rows;
    return rows.map(row => ({ connection: connectionOf(row), identity: identityOf(row) }));
  }

  async owned(ownerAccountId: string): Promise<OwnedConnection[]> {
    return (await this.pool.query(`SELECT ${COLUMNS}, credentials IS NOT NULL AS has_credentials, last_event_at, EXISTS (SELECT 1 FROM hatch_channel_identities i WHERE i.connection_id = c.id AND i.role = 'owner') AS linked,
      (SELECT i.sender_id FROM hatch_channel_identities i WHERE i.connection_id = c.id AND i.role = 'owner' LIMIT 1) AS sender_id
      FROM hatch_connections c WHERE owner_account_id = $1 AND (credentials IS NOT NULL OR audience <> 'public') ORDER BY created_at`, [ownerAccountId])).rows.map(row => ({
      ...connectionOf(row), linked: row.linked, hasCredentials: row.has_credentials, ...(row.sender_id ? { senderId: row.sender_id } : {}), ...(row.last_event_at ? { lastEventAt: new Date(row.last_event_at).toISOString() } : {}),
    }));
  }

  async contactCount(connectionId: string): Promise<number> {
    return (await this.pool.query("SELECT count(*)::int AS n FROM hatch_channel_identities WHERE connection_id = $1", [connectionId])).rows[0].n;
  }

  async get(id: string): Promise<ChannelConnection | undefined> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const row = (await this.pool.query(`SELECT ${COLUMNS} FROM hatch_connections WHERE id = $1`, [id])).rows[0];
    return row && connectionOf(row);
  }

  async touch(id: string): Promise<void> { await this.pool.query("UPDATE hatch_connections SET last_event_at = now() WHERE id = $1", [id]); }

  async setState(id: string, state: ConnectionState): Promise<void> {
    await this.pool.query("UPDATE hatch_connections SET state = $2 WHERE id = $1 AND state = $3", [id, state, state === "degraded" ? "active" : "degraded"]);
  }

  async unbind(ownerAccountId: string, channel: ChannelKind, target: AgentTarget = STUDIO_TARGET): Promise<void> {
    await this.pool.query("DELETE FROM hatch_connections WHERE owner_account_id = $1 AND channel = $2 AND audience = 'self' AND target_key = $3", [ownerAccountId, channel, targetKey(target)]);
  }

  async unbindPersonal(id: string): Promise<boolean> {
    return (await this.pool.query("DELETE FROM hatch_connections WHERE id = $1 AND audience = 'self'", [id])).rowCount! > 0;
  }

  async unbindSender(channel: ChannelKind, scope: string, senderId: string): Promise<void> {
    await this.transaction(async client => {
      await client.query("DELETE FROM hatch_connections WHERE audience = 'self' AND id IN (SELECT connection_id FROM hatch_channel_identities WHERE channel = $1 AND scope = $2 AND sender_id = $3)", [channel, scope, senderId]);
      await client.query("DELETE FROM hatch_channel_identities WHERE channel = $1 AND scope = $2 AND sender_id = $3", [channel, scope, senderId]);
    });
  }

  async saveCredentials(ownerAccountId: string, channel: ChannelKind, sealed: string, scope = this.scopeOf(ownerAccountId, channel), target: AgentTarget = STUDIO_TARGET): Promise<void> {
    await this.transaction(async client => {
      const audience = target.kind === "assistant" ? "self" : "public";
      const before = (await client.query("SELECT scope FROM hatch_connections WHERE owner_account_id = $1 AND channel = $2 AND audience = $3 AND target_key = $4 AND (credentials IS NOT NULL OR audience <> 'public') FOR UPDATE", [ownerAccountId, channel, audience, targetKey(target)])).rows[0];
      const id = (await client.query(`INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience, credentials)
        VALUES ($1, $2, $3, $5, $6, $7, $4)
        ON CONFLICT (owner_account_id, channel, audience, target_key) ${ACTIVE} DO UPDATE SET credentials = $4, scope = $3, state = 'active' RETURNING id`,
      [ownerAccountId, channel, scope, sealed, JSON.stringify(target), targetKey(target), audience])).rows[0].id;
      // Under a new scope nobody who was bound under the old one is known any more.
      if (before && before.scope !== scope) {
        await client.query("DELETE FROM hatch_channel_identities WHERE connection_id = $1", [id]);
      }
    });
  }

  async botHolder(channel: ChannelKind, scope: string): Promise<{ ownerAccountId: string; target: AgentTarget } | undefined> {
    const row = (await this.pool.query("SELECT owner_account_id, target FROM hatch_connections WHERE channel = $1 AND scope = $2 AND audience = 'public'", [channel, scope])).rows[0];
    return row && { ownerAccountId: row.owner_account_id, target: row.target };
  }

  /** Moves a Connection to a new scope with everything that is kept under the old one. Not when another Connection already holds the new scope. */
  private async rescope(client: PoolClient, id: string, channel: ChannelKind, from: string, to: string): Promise<boolean> {
    if (from === to || (await client.query("SELECT 1 FROM hatch_connections WHERE channel = $1 AND scope = $2", [channel, to])).rowCount) return false;
    await client.query("UPDATE hatch_connections SET scope = $2 WHERE id = $1", [id, to]);
    for (const table of ["hatch_channel_identities", "hatch_channel_inbox", "hatch_channel_outbox"]) await client.query(`UPDATE ${table} SET scope = $3 WHERE channel = $1 AND scope = $2`, [channel, from, to]);
    return true;
  }

  async bindBot(ownerAccountId: string, channel: ChannelKind, target: AgentTarget, scope: string, sealed: string, legacy?: { scope: string; as: string }): Promise<void> {
    await this.transaction(async client => {
      const mine = "owner_account_id = $1 AND channel = $2 AND audience = 'public' AND target_key = $3";
      const ours = [ownerAccountId, channel, targetKey(target)];
      // A bot made before bots had a scope of their own: it is the same bot, under the scope it was saved with. Its Connection moves.
      const live = legacy && (await client.query(`SELECT id FROM hatch_connections WHERE ${mine} AND scope = $4 AND credentials IS NOT NULL FOR UPDATE`, [...ours, legacy.scope])).rows[0];
      if (live) await this.rescope(client, live.id, channel, legacy!.scope, legacy!.as);
      const held = (await client.query("SELECT id, owner_account_id, target_key FROM hatch_connections WHERE channel = $1 AND scope = $2 AND audience = 'public' FOR UPDATE", [channel, scope])).rows[0];
      if (held && (held.owner_account_id !== ownerAccountId || held.target_key !== ours[2])) throw Object.assign(new Error("This bot is already connected to another Agent."), { status: 409, code: `${channel}_bot_in_use` });
      // The Product has one live bot: any other goes dormant, with its contacts and conversations.
      await client.query(`UPDATE hatch_connections SET credentials = NULL WHERE ${mine} AND scope <> $4 AND credentials IS NOT NULL`, [...ours, scope]);
      if (held) await client.query("UPDATE hatch_connections SET credentials = $2, state = 'active' WHERE id = $1", [held.id, sealed]);
      else await client.query("INSERT INTO hatch_connections (owner_account_id, channel, scope, target, target_key, audience, credentials) VALUES ($1, $2, $3, $4, $5, 'public', $6)", [ownerAccountId, channel, scope, JSON.stringify(target), ours[2], sealed]);
    });
  }

  async sleepBot(ownerAccountId: string, channel: ChannelKind, target: AgentTarget, as?: string): Promise<void> {
    await this.transaction(async client => {
      const live = (await client.query("SELECT id, scope FROM hatch_connections WHERE owner_account_id = $1 AND channel = $2 AND audience = 'public' AND target_key = $3 AND credentials IS NOT NULL FOR UPDATE", [ownerAccountId, channel, targetKey(target)])).rows[0];
      if (!live) return;
      if (as) await this.rescope(client, live.id, channel, live.scope, as);
      await client.query("UPDATE hatch_connections SET credentials = NULL WHERE id = $1", [live.id]);
    });
  }

  async credentials(ownerAccountId: string, channel: ChannelKind): Promise<string | undefined> {
    return (await this.pool.query("SELECT credentials FROM hatch_connections WHERE owner_account_id = $1 AND channel = $2 AND audience = 'self' AND target_key = 'assistant'", [ownerAccountId, channel])).rows[0]?.credentials ?? undefined;
  }

  async credentialsOf(channel: ChannelKind, scope: string): Promise<string | undefined> {
    if (!scope) return undefined;
    return (await this.pool.query("SELECT credentials FROM hatch_connections WHERE channel = $1 AND scope = $2 AND credentials IS NOT NULL ORDER BY created_at LIMIT 1", [channel, scope])).rows[0]?.credentials ?? undefined;
  }

  async ownerOfCode(channel: ChannelKind, code: string, now = new Date()): Promise<string | undefined> {
    return (await this.pool.query("SELECT owner_account_id FROM hatch_connections WHERE channel = $1 AND link_code = $2 AND link_expires_at > $3", [channel, code, now])).rows[0]?.owner_account_id ?? undefined;
  }

  async unbindTenant(channel: ChannelKind, scope: string): Promise<void> {
    if (!scope) return;
    await this.pool.query("DELETE FROM hatch_connections WHERE channel = $1 AND scope = $2", [channel, scope]);
  }

  async listening(): Promise<Array<{ ownerAccountId: string; channel: ChannelKind; scope: string }>> {
    return (await this.pool.query("SELECT DISTINCT owner_account_id, channel, scope FROM hatch_connections WHERE credentials IS NOT NULL")).rows
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
