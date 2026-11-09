import type { PostgresQueryExecutor } from "../postgresStore.js";
import { Asset, AssetError, scopeKey, type AssetRecord, type AssetRepository, type AssetScope, type AssetState } from "./domain.js";

/** In-process adapter for tests and single-node development. It follows the same contract as the database one. */
export class InMemoryAssetRepository implements AssetRepository {
  private readonly rows = new Map<string, Asset>();

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
    const current = this.find(scope, id); // no await between check and write: atomic in one process
    if (!current) throw new AssetError("not_found", `Asset ${id} does not exist`);
    const attached = current.attachedTo(messageId);
    this.rows.set(id, attached);
    return attached;
  }
  async release(scope: AssetScope, id: string, messageId: string) {
    const current = this.find(scope, id);
    if (current) this.rows.set(id, current.released(messageId));
  }
  async listAttached(scope: AssetScope) {
    const key = scopeKey(scope);
    return [...this.rows.values()].filter(a => a.messageId && scopeKey(a.record.scope) === key);
  }
}

export const POSTGRES_ASSET_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_assets (
  id text PRIMARY KEY,
  scope_key text NOT NULL,
  sha256 text NOT NULL,
  state text NOT NULL CHECK (state IN ('processing', 'ready', 'failed')),
  message_id text,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (message_id IS NULL OR state = 'ready')
);
CREATE UNIQUE INDEX IF NOT EXISTS hatch_assets_scope_sha256 ON hatch_assets (scope_key, sha256) WHERE state <> 'failed';
CREATE INDEX IF NOT EXISTS hatch_assets_scope_message ON hatch_assets (scope_key, message_id) WHERE message_id IS NOT NULL;
`;

type Row = { record: AssetRecord };
const restore = (row: Row | undefined) => row && Asset.restore(row.record);

/** Idempotency and one-message binding are enforced by the unique index, the CHECKs and conditional UPDATEs. */
export class PostgresAssetRepository implements AssetRepository {
  constructor(private readonly db: PostgresQueryExecutor) {}

  initialize() { return this.db.query(POSTGRES_ASSET_SCHEMA); }

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
    const result = await this.db.query<Row>(
      `UPDATE hatch_assets SET message_id = $3, record = jsonb_set(record, '{messageId}', to_jsonb($3::text))
       WHERE scope_key = $1 AND id = $2 AND state = 'ready' AND (message_id IS NULL OR message_id = $3) RETURNING record`,
      [scopeKey(scope), id, messageId]);
    if (result.rows[0]) return restore(result.rows[0])!;
    const current = await this.get(scope, id);
    if (!current) throw new AssetError("not_found", `Asset ${id} does not exist`);
    return current.attachedTo(messageId); // names the reason: not ready, or bound to another message
  }
  async release(scope: AssetScope, id: string, messageId: string) {
    await this.db.query(
      `UPDATE hatch_assets SET message_id = NULL, record = record - 'messageId' WHERE scope_key = $1 AND id = $2 AND message_id = $3`,
      [scopeKey(scope), id, messageId]);
  }
  async listAttached(scope: AssetScope) {
    const result = await this.db.query<Row>(`SELECT record FROM hatch_assets WHERE scope_key = $1 AND message_id IS NOT NULL ORDER BY created_at, id`, [scopeKey(scope)]);
    return result.rows.map(row => restore(row)!);
  }
}
