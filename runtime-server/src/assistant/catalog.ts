/** A storefront change the Expert must confirm before it is applied. */
export type AgentChange = { release?: "publish" | "withdraw"; name?: string; promise?: string; pricing?: unknown; briefSpec?: unknown };

export type CatalogAgent = {
  productId: string;
  name: string;
  promise: string;
  status: "draft" | "working" | "published";
  pricing?: unknown;
  briefSpec?: unknown;
};

/**
 * Port: the Expert's Agents as the Registry owns them. The Assistant reads and
 * changes them only through this port, with the same rules Studio's routes apply.
 */
export interface AgentCatalog {
  list(accountId: string): Promise<CatalogAgent[]>;
  get(accountId: string, productId: string): Promise<CatalogAgent | undefined>;
  create(accountId: string, name: string, promise: string): Promise<CatalogAgent>;
  apply(accountId: string, productId: string, change: AgentChange): Promise<void>;
  /** The Product's release state, from the same interface Studio uses. Null when publishing is unavailable. */
  live(accountId: string, productId: string, known?: CatalogAgent): Promise<unknown>;
  /** A session token that authorizes background work on this account's Product workspaces. */
  token(accountId: string): Promise<string>;
}
