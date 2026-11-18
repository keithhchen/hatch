import type { PostgresQueryExecutor } from "../postgresStore.js";

/** A Product's own sandbox: a box per buyer, files saved from it, and HTML pages published from those files. */
export const AGENT_BOX_CAPABILITY = "agent_box";

/** What a Product may do beyond chat, switched on per Product by a row: no deploy. */
export interface ProductCapabilities {
  has(productId: string, capability: string): Promise<boolean>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_product_capabilities (
  product_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, capability)
);`;

export class PostgresProductCapabilities implements ProductCapabilities {
  constructor(private readonly db: PostgresQueryExecutor) {}
  async initialize(): Promise<void> { await this.db.query(SCHEMA); }
  async has(productId: string, capability: string): Promise<boolean> {
    const result = await this.db.query("SELECT 1 FROM hatch_product_capabilities WHERE product_id = $1 AND capability = $2", [productId, capability]);
    return result.rows.length > 0;
  }
}

export class InMemoryProductCapabilities implements ProductCapabilities {
  constructor(private readonly rows: Array<[productId: string, capability: string]> = []) {}
  async has(productId: string, capability: string): Promise<boolean> {
    return this.rows.some(([p, c]) => p === productId && c === capability);
  }
}
