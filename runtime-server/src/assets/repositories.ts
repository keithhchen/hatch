import type { PostgresQueryExecutor } from "../postgresStore.js";
import { Asset, AssetError, scopeKey, type AssetRecord, type AssetRepository, type AssetScope, type AssetState, type AttachedAsset } from "./domain.js";

/** In-process adapter for tests and single-node development. It follows the same contract as the database one. */
export class InMemoryAssetRepository implements AssetRepository {
  private readonly rows = new Map<string, Asset>();
  private readonly links = new Set<string>();

  on() { return this; }

  async insertIfAbsent(asset: Asset) {
    const { scope, sha256 } = asset.record;
    const existing = [...this.rows.values()].find(a => a.state !== "failed" && a.record.sha256 === sha256 && scopeKey(a.record.scope) === scopeKey(scope));
    if (existing) return { asset: existing, created: false };
    this.rows.set(asset.id, asset);
    return { asset, created: true };
  }
  async transition(from: AssetState, next: Asset) {
    if (this.rows.get(next.id)?.state !== from) return undefined;
    this.rows.set(next.id, next);
    return next;
  }
  async get(scope: AssetScope, id: string) { return this.find(scope, id); }
  private find(scope: AssetScope, id: string) {
    const asset = this.rows.get(id);
    return asset && scopeKey(asset.record.scope) === scopeKey(scope) ? asset : undefined;
  }
  async attach(scope: AssetScope, id: string, messageId: string) {
    const current = this.find(scope, id);
    if (!current) throw new AssetError("not_found", `Asset ${id} does not exist`);
    if (current.state !== "ready") throw new AssetError("not_ready", `Asset ${id} is ${current.state}`);
    this.links.add(`${id}\0${messageId}`);
    return current;
  }
  async release(scope: AssetScope, id: string, messageId: string) {
    if (this.find(scope, id)) this.links.delete(`${id}\0${messageId}`);
  }
  async listAttached(scope: AssetScope): Promise<AttachedAsset[]> {
    const key = scopeKey(scope);
    return [...this.links].flatMap(link => {
      const [id, messageId] = link.split("\0") as [string, string];
      const asset = this.rows.get(id);
      return asset && scopeKey(asset.record.scope) === key ? [{ asset, messageId }] : [];
    });
  }
}

/**
 * An asset is content, unique per (scope, sha256); a message links to it. The link table is the one record of what a
 * message carried. Databases from when an asset held one message_id are migrated once: their bindings become links
 * and the column goes. Both steps are idempotent, so every start may run them.
 */
export const POSTGRES_ASSET_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_assets (
  id text PRIMARY KEY,
  scope_key text NOT NULL,
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing', 'ready', 'failed')),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS hatch_assets_scope_sha256 ON hatch_assets (scope_key, sha256) WHERE state <> 'failed';
CREATE TABLE IF NOT EXISTS hatch_asset_messages (
  asset_id text NOT NULL REFERENCES hatch_assets (id) ON DELETE CASCADE,
  message_id text NOT NULL,
  scope_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (asset_id, message_id)
);
CREATE INDEX IF NOT EXISTS hatch_asset_messages_scope ON hatch_asset_messages (scope_key, created_at);
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'hatch_assets' AND column_name = 'message_id') THEN
    INSERT INTO hatch_asset_messages (asset_id, message_id, scope_key, created_at)
      SELECT id, message_id, scope_key, created_at FROM hatch_assets WHERE message_id IS NOT NULL ON CONFLICT DO NOTHING;
    UPDATE hatch_assets SET record = record - 'messageId' WHERE record ? 'messageId';
    ALTER TABLE hatch_assets DROP COLUMN message_id;
  END IF;
END $$;
`;

type Row = { record: AssetRecord };
const restore = (row: Row | undefined) => row && Asset.restore(row.record);

/** Idempotency is enforced by the unique index and the link table's key; a link cannot outlive its asset. */
export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}

  initialize() { return this.db.query(POSTGRES_ASSET_SCHEMA); }

  on(tx?: unknown): AssetRepository { return tx ? new PostgresAssetRepository(tx as PostgresQueryExecutor) : this; }

  async insertIfAbsent(asset: Asset) {
    const { scope, sha256 } = asset.record;
    const key = scopeKey(scope);
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.db.query<Row>(
        `INSERT INTO hatch_assets (id, scope_key, sha256, state, record) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (scope_key, sha256) WHERE state <> 'failed' DO NOTHING RETURNING record`,
        [asset.id, key, sha256, asset.state, JSON.stringify(asset.record)]);
      if (inserted.rows[0]) return { asset, created: true };
      const existing = await this.db.query<Row>(`SELECT record FROM hatch_assets WHERE scope_key = $1 AND sha256 = $2 AND state <> 'failed'`, [key, sha256]);
      if (existing.rows[0]) return { asset: restore(existing.rows[0])!, created: false };
    }
    throw new Error("Could not place the asset");
  }
  async transition(from: AssetState, next: Asset) {
    const result = await this.db.query<Row>(
      `UPDATE hatch_assets SET state = $1, record = $2 WHERE id = $3 AND state = $4 RETURNING record`,
      [next.state, JSON.stringify(next.record), next.id, from]);
    return restore(result.rows[0]);
  }
  async get(scope: AssetScope, id: string) {
    const result = await this.db.query<Row>(`SELECT record FROM hatch_assets WHERE scope_key = $1 AND id = $2`, [scopeKey(scope), id]);
    return restore(result.rows[0]);
  }
  async attach(scope: AssetScope, id: string, messageId: string) {
    const asset = await this.get(scope, id);
    if (!asset) throw new AssetError("not_found", `Asset ${id} does not exist`);
    if (asset.state !== "ready") throw new AssetError("not_ready", `Asset ${id} is ${asset.state}`);
    await this.db.query(`INSERT INTO hatch_asset_messages (asset_id, message_id, scope_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, messageId, scopeKey(scope)]);
    return asset;
  }
  async release(scope: AssetScope, id: string, messageId: string) {
    await this.db.query(`DELETE FROM hatch_asset_messages WHERE scope_key = $1 AND asset_id = $2 AND message_id = $3`, [scopeKey(scope), id, messageId]);
  }
  async listAttached(scope: AssetScope): Promise<AttachedAsset[]> {
    const result = await this.db.query<Row & { message_id: string }>(
      `SELECT a.record, l.message_id FROM hatch_asset_messages l JOIN hatch_assets a ON a.id = l.asset_id
       WHERE l.scope_key = $1 ORDER BY l.created_at, a.created_at, a.id, l.message_id`, [scopeKey(scope)]);
    return result.rows.map(row => ({ asset: restore(row)!, messageId: row.message_id }));
  }
}
