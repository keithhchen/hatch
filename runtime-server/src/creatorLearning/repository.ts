import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";
import { createPool } from "../postgresPool.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";
import type { CreateCreatorProductInput, CreatorProductRecord, CreatorProductRepository } from "./products.js";
import { validateProductText } from "./products.js";
import { draftBriefSpecForProduct, normalizeBriefSpec, type BriefSpec } from "../brief.js";
import { EMPTY_PRODUCT_PRICING, normalizeProductPricing, type ProductPricing } from "./pricing.js";

/** Durable storage of the Expert's Products (hatch_creator_products). */

export class CreatorFactoryRepositoryError extends Error {
  constructor(
    readonly code:
      | "run_not_found"
      | "run_id_conflict"
      | "idempotency_conflict"
      | "creator_mismatch"
      | "version_conflict"
      | "invalid_status"
      | "invalid_stage"
      | "lease_lost",
    message: string
  ) {
    super(message);
    this.name = "CreatorFactoryRepositoryError";
  }
}

export interface CreatorFactoryRepository {
  initialize(): Promise<void>;
  close(): Promise<void>;
}

export class InMemoryCreatorFactoryRepository implements CreatorFactoryRepository, CreatorProductRepository {
  private readonly products = new Map<string, CreatorProductRecord>();
  private readonly productRequests = new Map<string, { productId: string; inputDigest: string }>();
  private writeChain: Promise<void> = Promise.resolve();

  async initialize(): Promise<void> {}

  async close(): Promise<void> {
    await this.writeChain;
  }

  async createProduct(input: CreateCreatorProductInput): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const id = requireNonEmpty(input.id, "product.id");
      const creatorId = requireNonEmpty(input.creatorId, "product.creatorId");
      const inputDigest = productInputDigest(input);
      const requestKey = input.idempotencyKey?.trim() ? `${creatorId}\u0000${input.idempotencyKey.trim()}` : undefined;
      const replay = requestKey ? this.productRequests.get(requestKey) : undefined;
      if (replay) {
        assertIdempotentDigest(replay.inputDigest, inputDigest, input.idempotencyKey!);
        return cloneJson(this.products.get(replay.productId)!);
      }
      if (this.products.has(id)) throw new CreatorFactoryRepositoryError("run_id_conflict", `Product ${id} already exists`);
      const now = new Date().toISOString();
      const product: CreatorProductRecord = {
        id,
        creatorId,
        name: validateProductText(input.name, "product.name", 240),
        promise: validateProductText(input.promise, "product.promise"),
        brief: validateProductText(input.promise, "product.promise"),
        briefSpec: normalizeBriefSpec(input.briefSpec),
        pricing: EMPTY_PRODUCT_PRICING,
        status: "active",
        ...(input.runId ? { runId: requireNonEmpty(input.runId, "product.runId") } : {}),
        createdAt: now,
        updatedAt: now
      };
      this.products.set(id, product);
      if (requestKey) this.productRequests.set(requestKey, { productId: id, inputDigest });
      return cloneJson(product);
    });
  }

  async getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord | undefined> {
    await this.writeChain;
    const product = this.products.get(productId);
    return product?.creatorId === creatorId ? cloneJson(product) : undefined;
  }

  async listProducts(creatorId: string): Promise<CreatorProductRecord[]> {
    await this.writeChain;
    return [...this.products.values()]
      .filter((product) => product.creatorId === creatorId && product.status !== "deleted")
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
      .map(cloneJson);
  }

  async updateProductPromise(creatorId: string, productId: string, input: { name?: string; promise: string; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (input.expectedUpdatedAt && product.updatedAt !== input.expectedUpdatedAt) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
      }
      const promise = validateProductText(input.promise, "product.promise");
      if (input.name !== undefined) product.name = validateProductText(input.name, "product.name", 240);
      product.promise = promise;
      product.brief = promise;
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async saveBriefSpec(creatorId: string, productId: string, input: { briefSpec: BriefSpec; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (input.expectedUpdatedAt && product.updatedAt !== input.expectedUpdatedAt) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
      }
      product.briefSpec = normalizeBriefSpec(input.briefSpec);
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async savePricing(creatorId: string, productId: string, input: { pricing: ProductPricing; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Product ${productId} was not found`);
      if (product.status !== "active") throw new CreatorFactoryRepositoryError("invalid_status", `Distillation Product ${productId} is deleted`);
      if (input.expectedUpdatedAt && product.updatedAt !== input.expectedUpdatedAt) {
        throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
      }
      product.pricing = normalizeProductPricing(input.pricing);
      product.updatedAt = new Date().toISOString();
      return cloneJson(product);
    });
  }

  async softDeleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    return this.write(async () => {
      const product = this.products.get(productId);
      if (!product || product.creatorId !== creatorId) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      const now = new Date().toISOString();
      product.status = "deleted";
      product.deletedAt = now;
      product.updatedAt = now;
      return cloneJson(product);
    });
  }

  private async write<T>(operation: () => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T | PromiseLike<T>) => void;
    let rejectResult!: (reason?: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.writeChain = this.writeChain.then(async () => {
      try {
        resolveResult(await operation());
      } catch (error) {
        rejectResult(error);
      }
    });
    await this.writeChain;
    return result;
  }
}

export const POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_creator_products (
  id TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  name TEXT NOT NULL,
  promise TEXT NOT NULL,
  -- Read-only migration column for databases created before Product-only.
  brief TEXT,
  brief_spec JSONB,
  idempotency_key TEXT,
  input_digest TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'deleted')) DEFAULT 'active',
  run_id TEXT,
  latest_revision_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS hatch_creator_products_creator_idx
  ON hatch_creator_products (creator_id, updated_at DESC);
-- Bring columns required by the Product authority into older schemas before
-- the legacy Task import below. Existing rows must contain enough historical
-- material to derive a real promise; otherwise startup fails explicitly.
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS brief TEXT;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS brief_spec JSONB;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS input_digest TEXT;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS latest_revision_id TEXT;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE hatch_creator_products ADD COLUMN IF NOT EXISTS promise TEXT;
UPDATE hatch_creator_products
SET promise = COALESCE(NULLIF(promise, ''), NULLIF(brief, ''), NULLIF(name, ''))
WHERE promise IS NULL OR promise = '';
ALTER TABLE hatch_creator_products ALTER COLUMN promise SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hatch_creator_products_idempotency_idx
  ON hatch_creator_products (creator_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

-- One-time read-time cutover for databases created before Product-only. The
-- legacy table is historical input only; Product rows are the sole authority
-- after this idempotent INSERT. No Task route or second write path is kept.
DO $$
BEGIN
  IF to_regclass('hatch_creator_distillation_tasks') IS NOT NULL THEN
    EXECUTE $migration$
      INSERT INTO hatch_creator_products
        (id, creator_id, name, promise, brief, status, run_id, latest_revision_id, created_at, updated_at, deleted_at)
      SELECT
        COALESCE(NULLIF(legacy.product_id, ''), legacy.id),
        legacy.creator_id,
        legacy.name,
        COALESCE(NULLIF(legacy.brief, ''), NULLIF(legacy.name, '')),
        legacy.brief,
        CASE WHEN legacy.deleted_at IS NOT NULL OR legacy.status = 'deleted' THEN 'deleted' ELSE 'active' END,
        legacy.run_id,
        legacy.latest_revision_id,
        COALESCE(legacy.created_at, clock_timestamp()),
        COALESCE(legacy.updated_at, legacy.created_at, clock_timestamp()),
        legacy.deleted_at
      FROM hatch_creator_distillation_tasks AS legacy
      WHERE COALESCE(NULLIF(legacy.product_id, ''), legacy.id) IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    $migration$;
  END IF;
END $$;

ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS latest_revision_id TEXT;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS run_id TEXT;
UPDATE hatch_creator_products
SET promise = brief
WHERE promise IS NULL AND brief IS NOT NULL;
ALTER TABLE hatch_creator_products
  ALTER COLUMN brief DROP NOT NULL;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS brief_spec JSONB;
ALTER TABLE hatch_creator_products
  ADD COLUMN IF NOT EXISTS pricing JSONB;
`;

export type PostgresCreatorFactoryRepositoryOptions = {
  connectionString?: string;
  databaseUrl?: string;
  pool?: PostgresQueryExecutor;
  maxConnections?: number;
  environment?: NodeJS.ProcessEnv;
};

export class PostgresCreatorFactoryRepository implements CreatorFactoryRepository {
  readonly pool: PostgresQueryExecutor;
  private readonly ownsPool: boolean;
  private schemaPromise: Promise<void> | undefined;

  constructor(connectionString: string);
  constructor(options?: PostgresCreatorFactoryRepositoryOptions);
  constructor(pool: PostgresQueryExecutor);
  constructor(input: string | PostgresCreatorFactoryRepositoryOptions | PostgresQueryExecutor = {}) {
    if (typeof input === "string") {
      this.pool = createPool({ connectionString: input });
      this.ownsPool = true;
      return;
    }
    if (isQueryExecutor(input)) {
      this.pool = input;
      this.ownsPool = false;
      return;
    }
    if (input.pool) {
      this.pool = input.pool;
      this.ownsPool = false;
      return;
    }
    const environment = input.environment ?? process.env;
    const connectionString = input.connectionString
      ?? input.databaseUrl
      ?? environment.HATCH_FACTORY_DATABASE_URL
      ?? environment.HATCH_RUNTIME_DATABASE_URL
      ?? environment.HATCH_REGISTRY_DATABASE_URL
      ?? environment.DATABASE_URL;
    if (!connectionString) throw new Error("Postgres Creator Factory repository requires a database connection string");
    this.pool = createPool({
      connectionString,
      ...(input.maxConnections === undefined ? {} : { max: input.maxConnections })
    });
    this.ownsPool = true;
  }

  async initialize(): Promise<void> {
    if (!this.schemaPromise) {
      this.schemaPromise = this.pool.query(POSTGRES_CREATOR_FACTORY_REPOSITORY_SCHEMA).then(() => undefined);
    }
    await this.schemaPromise;
  }

  async close(): Promise<void> {
    if (this.ownsPool) await this.pool.end?.();
  }

  async createProduct(input: CreateCreatorProductInput): Promise<CreatorProductRecord> {
    await this.initialize();
    const id = requireNonEmpty(input.id, "product.id");
    const creatorId = requireNonEmpty(input.creatorId, "product.creatorId");
    const name = validateProductText(input.name, "product.name", 240);
    const promise = validateProductText(input.promise, "product.promise");
    const briefSpec = normalizeBriefSpec(input.briefSpec);
    const idempotencyKey = input.idempotencyKey?.trim() || null;
    const inputDigest = productInputDigest(input);
    const runId = input.runId?.trim() || null;
    // Concurrent requests with one key race on the unique index: the loser inserts nothing and replays the winner's row.
    const result = await this.pool.query<ProductRow>(`
      INSERT INTO hatch_creator_products (id, creator_id, name, promise, brief_spec, run_id, idempotency_key, input_digest)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
      ON CONFLICT (creator_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING *
    `, [id, creatorId, name, promise, JSON.stringify(briefSpec), runId, idempotencyKey, inputDigest]);
    if (result.rows[0]) return productFromRow(result.rows[0]);
    const replay = await this.pool.query<ProductRow>(`
      SELECT * FROM hatch_creator_products WHERE creator_id = $1 AND idempotency_key = $2
    `, [creatorId, idempotencyKey]);
    const row = requireRow(replay.rows[0], "Product insert returned no row");
    assertIdempotentDigest(row.input_digest ?? "", inputDigest, idempotencyKey!);
    return productFromRow(row);
  }

  async getProduct(creatorId: string, productId: string): Promise<CreatorProductRecord | undefined> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      SELECT * FROM hatch_creator_products WHERE id = $1 AND creator_id = $2
    `, [productId, creatorId]);
    return result.rows[0] ? productFromRow(result.rows[0]) : undefined;
  }

  async listProducts(creatorId: string): Promise<CreatorProductRecord[]> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      SELECT * FROM hatch_creator_products
      WHERE creator_id = $1 AND status = 'active'
      ORDER BY updated_at DESC, id ASC
    `, [creatorId]);
    return result.rows.map(productFromRow);
  }

  async updateProductPromise(creatorId: string, productId: string, input: { name?: string; promise: string; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const promise = validateProductText(input.promise, "product.promise");
    const name = input.name === undefined ? null : validateProductText(input.name, "product.name", 240);
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET name = COALESCE($3, name), promise = $4, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        -- HTTP timestamps are serialized to milliseconds while Postgres
        -- stores microseconds. Compare at the public precision so a fresh
        -- Product read is not rejected as stale solely by hidden precision.
        AND ($5::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $5::timestamptz))
      RETURNING *
    `, [productId, creatorId, name, promise, input.expectedUpdatedAt ?? null]);
    if (!result.rows[0]) {
      const current = await this.getProduct(creatorId, productId);
      if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
    }
    return productFromRow(result.rows[0]);
  }

  async saveBriefSpec(creatorId: string, productId: string, input: { briefSpec: BriefSpec; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const briefSpec = normalizeBriefSpec(input.briefSpec);
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET brief_spec = $3::jsonb, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        -- Keep the same millisecond-precision CAS contract as the Product
        -- promise mutation; the browser cannot observe Postgres microseconds.
        AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $4::timestamptz))
      RETURNING *
    `, [productId, creatorId, JSON.stringify(briefSpec), input.expectedUpdatedAt ?? null]);
    if (!result.rows[0]) {
      const current = await this.getProduct(creatorId, productId);
      if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
    }
    return productFromRow(result.rows[0]);
  }

  async savePricing(creatorId: string, productId: string, input: { pricing: ProductPricing; expectedUpdatedAt?: string }): Promise<CreatorProductRecord> {
    await this.initialize();
    const pricing = normalizeProductPricing(input.pricing);
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET pricing = $3::jsonb, updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2 AND status = 'active'
        AND ($4::timestamptz IS NULL OR date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $4::timestamptz))
      RETURNING *
    `, [productId, creatorId, JSON.stringify(pricing), input.expectedUpdatedAt ?? null]);
    if (!result.rows[0]) {
      const current = await this.getProduct(creatorId, productId);
      if (!current) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
      throw new CreatorFactoryRepositoryError("version_conflict", `Distillation Product ${productId} changed; refresh before saving`);
    }
    return productFromRow(result.rows[0]);
  }

  async softDeleteProduct(creatorId: string, productId: string): Promise<CreatorProductRecord> {
    await this.initialize();
    const result = await this.pool.query<ProductRow>(`
      UPDATE hatch_creator_products
      SET status = 'deleted', deleted_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = $1 AND creator_id = $2
      RETURNING *
    `, [productId, creatorId]);
    if (!result.rows[0]) throw new CreatorFactoryRepositoryError("run_not_found", `Distillation Product ${productId} was not found`);
    return productFromRow(result.rows[0]);
  }

}

function productInputDigest(input: CreateCreatorProductInput): string {
  return createHash("sha256").update(JSON.stringify({
    name: validateProductText(input.name, "product.name", 240),
    promise: validateProductText(input.promise, "product.promise"),
    briefSpec: normalizeBriefSpec(input.briefSpec)
  })).digest("hex");
}

type ProductRow = QueryResultRow & {
  id: string;
  creator_id: string;
  name: string;
  promise: string | null;
  brief: string | null;
  brief_spec: BriefSpec | string | null;
  pricing?: ProductPricing | string | null;
  status: "active" | "deleted";
  run_id: string | null;
  latest_revision_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
  deleted_at: string | Date | null;
};

function productFromRow(row: ProductRow): CreatorProductRecord {
  const promise = validateProductText(row.promise ?? row.brief ?? "", "product.promise");
  // Existing rows from before the Brief contract are upgraded at the read
  // boundary with the same deterministic Factory draft used for new Products.
  // New writes always persist brief_spec JSONB, so this is a one-time legacy
  // migration path rather than a second source of authority.
  const briefSpec = row.brief_spec
    ? normalizeBriefSpec(typeof row.brief_spec === "string" ? JSON.parse(row.brief_spec) : row.brief_spec)
    : draftBriefSpecForProduct(row.name, promise);
  return {
    id: row.id,
    creatorId: row.creator_id,
    name: row.name,
    promise,
    // Keep legacy workers readable while Product.id remains the only identity.
    brief: promise,
    briefSpec,
    pricing: row.pricing
      ? normalizeProductPricing(typeof row.pricing === "string" ? JSON.parse(row.pricing) : row.pricing)
      : EMPTY_PRODUCT_PRICING,
    status: row.status,
    ...(row.run_id ? { runId: row.run_id } : {}),
    ...(row.latest_revision_id ? { latestRevisionId: row.latest_revision_id } : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {})
  };
}

function iso(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid timestamp: ${String(value)}`);
  return date.toISOString();
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} must not be empty`);
  return normalized;
}

function assertIdempotentDigest(existing: string, incoming: string, key: string): void {
  if (existing === incoming) return;
  throw new CreatorFactoryRepositoryError(
    "idempotency_conflict",
    `Idempotency key ${key} was already used with a different payload`
  );
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function isQueryExecutor(value: unknown): value is PostgresQueryExecutor {
  return typeof value === "object"
    && value !== null
    && "query" in value
    && typeof (value as { query?: unknown }).query === "function";
}
