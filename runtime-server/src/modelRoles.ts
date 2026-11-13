import { ModelProfileError } from "./errors/modelProfile.js";
import { FACTORY_LLM_PROFILE_NAMES, RUNTIME_LLM_PROFILE_NAMES, llmProfile, type LlmProfile, type LlmProfileName } from "./llmProfiles.js";

/**
 * Which model plays which role: the seed rows of `hatch_model_roles`. A row is inserted only when its role has none;
 * from then on the database decides, and switching a model is an UPDATE (see runtime-server/README.md).
 * The catalogue of profiles (endpoint, limits, which API key) stays in llmProfiles.ts; keys stay in the environment.
 */
export const MODEL_ROLES = {
  /** Product chat: every Run of a published Product in the Runtime, its compaction and delivery review. A Product may override it (`hatch_product_models`). */
  chat: "kimi-k3.1-pro",
  /** The Studio Assistant's own chat, and its compaction. */
  assistant: "gemini-api",
  /** Creator Factory: the Product workbench, evidence extraction, evaluation and Corpus compilation. */
  factory: "gemini-3.1-pro",
  /** Hosted ingest's agent. Must be a Kimi profile: the hosted-agents API runs Kimi only. */
  ingest: "kimi-k3.1-pro"
} as const satisfies Record<string, LlmProfileName>;

export type ModelRole = keyof typeof MODEL_ROLES;
export const MODEL_ROLE_NAMES = Object.keys(MODEL_ROLES) as ModelRole[];

const ALLOWED: Record<ModelRole, readonly string[]> = {
  chat: RUNTIME_LLM_PROFILE_NAMES, assistant: RUNTIME_LLM_PROFILE_NAMES,
  factory: FACTORY_LLM_PROFILE_NAMES,
  ingest: ["kimi-k3.1-pro"]
};

/** What a use of a role is about: the Product whose chat this is, when it is one. */
export type ModelScope = { productId?: string };

/** Where a role's model is chosen. Read at the start of each Run, job or compaction: a Run keeps the model it began with. */
export interface ModelRoleResolver {
  resolve(role: ModelRole, scope?: ModelScope): Promise<LlmProfile>;
}

/** The profile a table row names for a role; an unknown or disallowed name is a loud error, never another model. */
export function profileForRole(role: ModelRole, name: string | undefined, source: string): LlmProfile {
  const profile = name?.trim();
  if (!profile || !ALLOWED[role].includes(profile)) {
    throw new ModelProfileError(
      `Model profile ${JSON.stringify(profile ?? null)} (${source}) is not valid for role ${role}. Expected one of: ${ALLOWED[role].join(", ")}`,
      { role, profile: profile ?? null, source }
    );
  }
  return llmProfile(profile as LlmProfileName);
}

type Choices = { roles?: Partial<Record<ModelRole, string>>; products?: Record<string, string> };

/** Tests and a Runtime without a database: the seed rows, and whatever a test sets. Nothing is cached. */
export class InMemoryModelRoleResolver implements ModelRoleResolver {
  private readonly roles: Record<ModelRole, string>;
  private readonly products = new Map<string, string>();
  constructor(choices: Choices = {}) {
    this.roles = { ...MODEL_ROLES, ...choices.roles };
    for (const [productId, profile] of Object.entries(choices.products ?? {})) this.products.set(productId, profile);
  }
  setRole(role: ModelRole, profile: string): void { this.roles[role] = profile; }
  setProduct(productId: string, profile: string): void { this.products.set(productId, profile); }
  async resolve(role: ModelRole, scope: ModelScope = {}): Promise<LlmProfile> {
    const override = role === "chat" && scope.productId ? this.products.get(scope.productId) : undefined;
    return override ? profileForRole(role, override, `hatch_product_models ${scope.productId}`) : profileForRole(role, this.roles[role], `hatch_model_roles ${role}`);
  }
}

/** What the Postgres adapter needs of a pool; a `pg` Pool or the Runtime's own query executor. */
export type ModelRolesDatabase = { query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }> };

/** The tables, for tools that seed a throwaway database. */
export const MODEL_ROLES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_model_roles (
  role TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hatch_product_models (
  product_id TEXT PRIMARY KEY,
  profile TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

export const MODEL_CACHE_MS = 30_000;

/** The database decides. Tables are made and seeded on first use; each choice is read at most every 30 seconds per key. */
export class PostgresModelRoleResolver implements ModelRoleResolver {
  private ready?: Promise<void>;
  private readonly cache = new Map<string, { at: number; profile: LlmProfile }>();
  constructor(private readonly pool: ModelRolesDatabase, private readonly options: { cacheMs?: number; now?: () => number } = {}) {}

  /** Creates the tables if absent and inserts a row for each role that has none. Safe under concurrent boots: CREATE runs under the schema lock, the insert skips what exists. */
  private ensure(): Promise<void> {
    return this.ready ??= (async () => {
      await this.pool.query(MODEL_ROLES_SCHEMA);
      await this.pool.query(
        "INSERT INTO hatch_model_roles (role, profile) SELECT * FROM unnest($1::text[], $2::text[]) ON CONFLICT (role) DO NOTHING",
        [MODEL_ROLE_NAMES, MODEL_ROLE_NAMES.map(role => MODEL_ROLES[role])]
      );
    })().catch(error => { this.ready = undefined; throw error; });
  }

  async resolve(role: ModelRole, scope: ModelScope = {}): Promise<LlmProfile> {
    const productId = role === "chat" ? scope.productId : undefined;
    const key = productId ? `${role}:${productId}` : role;
    const now = (this.options.now ?? Date.now)();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.options.cacheMs ?? MODEL_CACHE_MS)) return { ...hit.profile };
    await this.ensure();
    const override = productId ? (await this.pool.query("SELECT profile FROM hatch_product_models WHERE product_id = $1", [productId])).rows[0]?.profile as string | undefined : undefined;
    const profile = override
      ? profileForRole(role, override, `hatch_product_models ${productId}`)
      : profileForRole(role, (await this.pool.query("SELECT profile FROM hatch_model_roles WHERE role = $1", [role])).rows[0]?.profile as string | undefined, `hatch_model_roles ${role}`);
    this.cache.set(key, { at: now, profile });
    return { ...profile };
  }
}
