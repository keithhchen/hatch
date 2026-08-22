import type { Pool } from "pg";
import { isUuidV4, requireUuidV4 } from "../identity.js";

export type CreatorRegistryRelease = {
  product_id: string;
  creator_id: string;
  release_digest: string;
  corpus_digest: string;
  corpus_ref: string;
  release_ref: string;
  runtime_manifest_ref: string;
  brief_spec: unknown;
  status: "published";
  published_at: string;
};

export type ReleaseInput = Omit<CreatorRegistryRelease, "status" | "published_at"> & { published_at?: string };

export type PublicReleaseListing = CreatorRegistryRelease & {
  product_name: string;
  product_promise: string;
  creator_name: string;
};

/** New Registry authority for Distill Factory releases. */
export class CreatorRegistryReleaseStore {
  private readonly memory = new Map<string, CreatorRegistryRelease>();

  constructor(private readonly pool?: Pool) {}

  /** Exposed only for readiness/diagnostic reporting; never includes a DSN. */
  persistenceMode(): "postgres" | "memory" {
    return this.pool ? "postgres" : "memory";
  }

  async ensureSchema(): Promise<void> {
    if (!this.pool) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hatch_creator_registry_releases (
        product_id UUID NOT NULL,
        creator_id UUID NOT NULL,
        release_digest TEXT NOT NULL,
        corpus_digest TEXT NOT NULL,
        corpus_ref TEXT NOT NULL,
        release_ref TEXT NOT NULL,
        runtime_manifest_ref TEXT NOT NULL,
        brief_spec JSONB,
        status TEXT NOT NULL CHECK (status = 'published'),
        published_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (product_id, release_digest)
      );
      CREATE INDEX IF NOT EXISTS hatch_creator_registry_releases_product_time
        ON hatch_creator_registry_releases(product_id, published_at DESC);
      CREATE TABLE IF NOT EXISTS hatch_creator_registry_live (
        product_id UUID PRIMARY KEY,
        creator_id UUID NOT NULL,
        release_digest TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        FOREIGN KEY (product_id, release_digest)
          REFERENCES hatch_creator_registry_releases(product_id, release_digest)
      );
    `);
  }

  async publish(input: ReleaseInput): Promise<CreatorRegistryRelease> {
    requireUuidV4(input.product_id, "product_id");
    requireUuidV4(input.creator_id, "creator_id");
    const published: CreatorRegistryRelease = {
      ...input,
      status: "published",
      published_at: input.published_at ?? new Date().toISOString(),
    };
    if (!this.pool) {
      this.memory.set(input.product_id, published);
      return published;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        INSERT INTO hatch_creator_registry_releases
          (product_id, creator_id, release_digest, corpus_digest, corpus_ref,
           release_ref, runtime_manifest_ref, brief_spec, status, published_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
        ON CONFLICT (product_id, release_digest) DO UPDATE SET
          creator_id=EXCLUDED.creator_id,
          corpus_digest=EXCLUDED.corpus_digest,
          corpus_ref=EXCLUDED.corpus_ref,
          release_ref=EXCLUDED.release_ref,
          runtime_manifest_ref=EXCLUDED.runtime_manifest_ref,
          brief_spec=EXCLUDED.brief_spec,
          status=EXCLUDED.status,
          published_at=EXCLUDED.published_at
      `, [
        published.product_id,
        published.creator_id,
        published.release_digest,
        published.corpus_digest,
        published.corpus_ref,
        published.release_ref,
        published.runtime_manifest_ref,
        JSON.stringify(published.brief_spec ?? null),
        published.status,
        published.published_at,
      ]);
      // This is the only current-version mutation. It happens after all
      // immutable assets and the Qdrant stage have succeeded.
      await client.query(`
        INSERT INTO hatch_creator_registry_live(product_id, creator_id, release_digest, updated_at)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (product_id) DO UPDATE SET
          creator_id=EXCLUDED.creator_id,
          release_digest=EXCLUDED.release_digest,
          updated_at=EXCLUDED.updated_at
      `, [published.product_id, published.creator_id, published.release_digest, published.published_at]);
      await client.query("COMMIT");
      return published;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async getLive(productId: string): Promise<CreatorRegistryRelease | undefined> {
    requireUuidV4(productId, "product_id");
    if (!this.pool) return this.memory.get(productId);
    const result = await this.pool.query(`
      SELECT r.product_id, r.creator_id, r.release_digest, r.corpus_digest,
             r.corpus_ref, r.release_ref, r.runtime_manifest_ref,
             r.brief_spec, r.status, r.published_at
      FROM hatch_creator_registry_live AS l
      JOIN hatch_creator_registry_releases AS r
        ON r.product_id=l.product_id AND r.release_digest=l.release_digest
      WHERE l.product_id=$1 AND r.status='published'
    `, [productId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? rowToRelease(row) : undefined;
  }

  /** Public catalog authority: only the current release pointer is visible. */
  async listPublic(options: { limit?: number; offset?: number } = {}): Promise<PublicReleaseListing[]> {
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20_001) throw new Error("catalog limit is invalid");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error("catalog offset is invalid");
    if (!this.pool) {
      return [...this.memory.values()]
        .sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at))
        .slice(offset, offset + limit)
        .map((release) => ({
          ...release,
          product_name: release.product_id,
          product_promise: "",
          creator_name: release.creator_id
        }));
    }
    const result = await this.pool.query(`
      SELECT r.product_id, r.creator_id, r.release_digest, r.corpus_digest,
             r.corpus_ref, r.release_ref, r.runtime_manifest_ref,
             r.brief_spec, r.status, r.published_at,
             COALESCE(p.name, r.product_id::text) AS product_name,
             COALESCE(p.promise, '') AS product_promise,
             COALESCE(c.display_name, r.creator_id::text) AS creator_name
      FROM hatch_creator_registry_live AS l
      JOIN hatch_creator_registry_releases AS r
        ON r.product_id=l.product_id AND r.release_digest=l.release_digest
      LEFT JOIN hatch_creator_products AS p
        ON p.id=r.product_id::text AND p.status='active'
      LEFT JOIN creators AS c ON c.id=r.creator_id
      WHERE r.status='published'
      ORDER BY r.published_at DESC, r.product_id ASC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);
    return result.rows.map((row) => ({
      ...rowToRelease(row as Record<string, unknown>),
      product_name: String(row.product_name),
      product_promise: String(row.product_promise ?? ""),
      creator_name: String(row.creator_name)
    }));
  }

  async getPublic(productId: string): Promise<PublicReleaseListing | undefined> {
    requireUuidV4(productId, "product_id");
    const rows = await this.listPublic({ limit: 20_001, offset: 0 });
    return rows.find((row) => row.product_id === productId);
  }
}

function rowToRelease(row: Record<string, unknown>): CreatorRegistryRelease {
  const productId = String(row.product_id);
  const creatorId = String(row.creator_id);
  if (!isUuidV4(productId) || !isUuidV4(creatorId)) throw new Error("Registry release identity is invalid");
  return {
    product_id: productId,
    creator_id: creatorId,
    release_digest: String(row.release_digest),
    corpus_digest: String(row.corpus_digest),
    corpus_ref: String(row.corpus_ref),
    release_ref: String(row.release_ref),
    runtime_manifest_ref: String(row.runtime_manifest_ref),
    brief_spec: row.brief_spec ?? null,
    status: "published",
    published_at: new Date(String(row.published_at)).toISOString(),
  };
}
