import { randomUUID } from "node:crypto";
import { isUuidV4 } from "./identity.js";

/** The shared Postgres authority store is migrated once, before Registry load. */
export type IdentityMigrationExecutor = {
  query: (text: string, values?: unknown[]) => Promise<{ rows?: Array<Record<string, any>>; rowCount?: number }>;
};

export type IdentityKind = "account" | "creator" | "product" | "order" | "entitlement";

const MIGRATION_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS uuid_identity_migrations (
    kind TEXT NOT NULL,
    legacy_id TEXT NOT NULL,
    uuid UUID NOT NULL,
    migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (kind, legacy_id),
    UNIQUE (kind, uuid)
  )`;

const KNOWN_CREATORS = new Map([
  ["seth", "32ffccf7-893d-4ef3-bdbc-c82fc8fcb90b"],
  ["maya-chen", "6f6a3d24-48af-4f27-9c50-0d4f7e4e8a21"],
  ["madeline-mann", "90e72cbf-c474-4897-baab-ae7261b0a89f"]
]);

const KNOWN_PRODUCTS = new Map([
  ["seth\u0000alpha-lite", "026651b1-8a8a-4484-aac5-ace6bd662157"],
  ["maya-chen\u0000signal-resume-review", "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"],
  ["maya-chen\u0000maya-chen-resume-review", "f9c4e2b7-7d14-4d72-9a63-1e91e58d6c42"],
  ["madeline-mann\u0000interview-answer-rewriter", "4f357cee-ea68-45cf-a364-bc771aea850e"]
]);

/**
 * Rewrites authority IDs in the shared database without inventing an
 * untracked compatibility alias. Every generated mapping is durable in
 * uuid_identity_migrations, so a retry is deterministic and auditable.
 *
 * The Registry starts before the Dashboard in production, so this function
 * also handles the Commerce/Portal JSON documents that already exist. New
 * Commerce commands are UUID-native and need no translation.
 */
export async function migrateUuidAuthorityIds(executor: IdentityMigrationExecutor): Promise<void> {
  const client = typeof (executor as any).connect === "function"
    ? await (executor as any).connect() as IdentityMigrationExecutor & { release?: () => void }
    : undefined;
  const db = client ?? executor;
  try {
    if (client) await db.query("BEGIN");
    await db.query("SELECT pg_advisory_xact_lock(718263411)");
    await db.query(MIGRATION_TABLE_SQL);
    const tables = await existingTables(db);
    const values = emptyIdentitySets();

    if (tables.has("accounts")) {
      const rows = await db.query("SELECT id FROM accounts");
      for (const row of rows.rows ?? []) collect(values, "account", row.id);
    }
    if (tables.has("agent_access")) {
      const rows = await db.query("SELECT entitlement_id, user_id, creator_id, agent_id, product_id, order_id FROM agent_access");
      for (const row of rows.rows ?? []) {
        collect(values, "entitlement", row.entitlement_id);
        collect(values, "account", row.user_id);
        collect(values, "creator", row.creator_id);
        collect(values, "product", row.agent_id);
        collect(values, "product", row.product_id);
        collect(values, "order", row.order_id);
      }
    }

    if (tables.has("tool_connections")) {
      const rows = await db.query("SELECT tenant_id FROM tool_connections");
      for (const row of rows.rows ?? []) collect(values, "creator", row.tenant_id);
    }
    if (tables.has("agent_tool_bindings")) {
      const rows = await db.query("SELECT tenant_id, agent_id FROM agent_tool_bindings");
      for (const row of rows.rows ?? []) {
        collect(values, "creator", row.tenant_id);
        collect(values, "product", row.agent_id);
      }
    }
    if (tables.has("hatch_creator_factory_runs")) {
      const rows = await db.query("SELECT creator_id FROM hatch_creator_factory_runs");
      for (const row of rows.rows ?? []) collect(values, "creator", row.creator_id);
    }
    if (tables.has("hatch_conversations")) {
      const rows = await db.query("SELECT owner_account_id, creator_id, agent_id, product_id, product_id_at_creation FROM hatch_conversations");
      for (const row of rows.rows ?? []) {
        collect(values, "account", row.owner_account_id);
        collect(values, "creator", row.creator_id);
        collect(values, "product", row.agent_id);
        collect(values, "product", row.product_id);
        collect(values, "product", row.product_id_at_creation);
      }
    }

    for (const table of ["commerce_events", "commerce_outbox", "commerce_inbox", "portal_workflow_state"]) {
      if (!tables.has(table)) continue;
      const rows = await db.query(
        table === "portal_workflow_state"
          ? "SELECT singleton, state FROM portal_workflow_state WHERE singleton = TRUE"
          : table === "commerce_events"
            ? "SELECT sequence, payload FROM commerce_events"
            : table === "commerce_outbox"
              ? "SELECT outbox_id, payload FROM commerce_outbox"
              : "SELECT consumer_name, idempotency_key, payload, result FROM commerce_inbox"
      );
      for (const row of rows.rows ?? []) {
        collectDocument(values, row.payload ?? row.state);
        if (table === "commerce_inbox") collectDocument(values, row.result);
      }
    }

    if (tables.has("commerce_read_models")) {
      const rows = await db.query(
        "SELECT model_type, model_id, buyer_id, creator_id, product_id, order_id, entitlement_id, snapshot FROM commerce_read_models"
      );
      for (const row of rows.rows ?? []) {
        collect(values, "account", row.buyer_id);
        collect(values, "creator", row.creator_id);
        collect(values, "product", row.product_id);
        collect(values, "order", row.order_id);
        collect(values, "entitlement", row.entitlement_id);
        collectDocument(values, row.snapshot);
      }
    }

    const mappings = new Map<string, string>();
    for (const kind of Object.keys(values) as IdentityKind[]) {
      for (const legacyId of values[kind]) {
        mappings.set(`${kind}\u0000${legacyId}`, await mappingFor(db, kind, legacyId));
      }
    }

    if (tables.has("accounts") && mappings.size) {
      if (tables.has("account_sessions")) {
        await db.query("ALTER TABLE account_sessions DROP CONSTRAINT IF EXISTS account_sessions_account_id_fkey");
      }
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind !== "account") continue;
        await db.query("UPDATE accounts SET id=$1 WHERE id=$2", [uuid, legacyId]);
        if (tables.has("account_sessions")) {
          await db.query("UPDATE account_sessions SET account_id=$1 WHERE account_id=$2", [uuid, legacyId]);
        }
        if (tables.has("hatch_conversations")) {
          await db.query("UPDATE hatch_conversations SET owner_account_id=$1 WHERE owner_account_id=$2", [uuid, legacyId]);
        }
      }
      if (tables.has("account_sessions")) {
        await db.query("ALTER TABLE account_sessions ADD CONSTRAINT account_sessions_account_id_fkey FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE");
      }
    }

    if (tables.has("agent_access")) {
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind === "entitlement") await db.query("UPDATE agent_access SET entitlement_id=$1 WHERE entitlement_id=$2", [uuid, legacyId]);
        if (kind === "account") await db.query("UPDATE agent_access SET user_id=$1 WHERE user_id=$2", [uuid, legacyId]);
        if (kind === "creator") await db.query("UPDATE agent_access SET creator_id=$1 WHERE creator_id=$2", [uuid, legacyId]);
        if (kind === "product") await db.query("UPDATE agent_access SET agent_id=$1, product_id=$1 WHERE agent_id=$2 OR product_id=$2", [uuid, legacyId]);
        if (kind === "order") await db.query("UPDATE agent_access SET order_id=$1 WHERE order_id=$2", [uuid, legacyId]);
      }
    }

    if (tables.has("hatch_conversations")) {
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind === "account") await db.query("UPDATE hatch_conversations SET owner_account_id=$1 WHERE owner_account_id=$2", [uuid, legacyId]);
        if (kind === "creator") await db.query("UPDATE hatch_conversations SET creator_id=$1 WHERE creator_id=$2", [uuid, legacyId]);
        if (kind === "product") await db.query("UPDATE hatch_conversations SET agent_id=$1, product_id=$1, product_id_at_creation=$1 WHERE agent_id=$2 OR product_id=$2 OR product_id_at_creation=$2", [uuid, legacyId]);
      }
    }

    if (tables.has("tool_connections")) {
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind === "creator") await db.query("UPDATE tool_connections SET tenant_id=$1 WHERE tenant_id=$2", [uuid, legacyId]);
      }
    }
    if (tables.has("agent_tool_bindings")) {
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind === "creator") await db.query("UPDATE agent_tool_bindings SET tenant_id=$1 WHERE tenant_id=$2", [uuid, legacyId]);
        if (kind === "product") await db.query("UPDATE agent_tool_bindings SET agent_id=$1 WHERE agent_id=$2", [uuid, legacyId]);
      }
    }
    if (tables.has("hatch_creator_factory_runs")) {
      for (const [key, uuid] of mappings) {
        const [kind, legacyId] = key.split("\u0000");
        if (kind === "creator") await db.query("UPDATE hatch_creator_factory_runs SET creator_id=$1 WHERE creator_id=$2", [uuid, legacyId]);
      }
    }

    await rewriteJsonTables(db, tables, mappings);
    await convertUuidColumns(db, tables);
    if (client) await db.query("COMMIT");
  } catch (error) {
    if (client) await db.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client?.release?.();
  }
}

/**
 * Legacy Registry table copies run before the current typed tables exist. They
 * use this same durable mapping table so account/order/entitlement IDs copied
 * during that phase cannot diverge from the later shared-database rewrite.
 */
export async function mapLegacyAuthorityId(
  executor: IdentityMigrationExecutor,
  kind: IdentityKind,
  value: unknown
): Promise<string> {
  const legacyId = typeof value === "string" ? value.trim() : "";
  if (!legacyId) throw new Error(`Registry UUID cutover found an empty ${kind} identity`);
  if (isUuidV4(legacyId)) return legacyId.toLowerCase();
  await executor.query(MIGRATION_TABLE_SQL);
  return mappingFor(executor, kind, legacyId);
}

function emptyIdentitySets(): Record<IdentityKind, Set<string>> {
  return {
    account: new Set(),
    creator: new Set(),
    product: new Set(),
    order: new Set(),
    entitlement: new Set()
  };
}

function collect(values: Record<IdentityKind, Set<string>>, kind: IdentityKind, value: unknown): void {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized && !isUuidV4(normalized)) values[kind].add(normalized);
}

function collectDocument(values: Record<IdentityKind, Set<string>>, document: unknown): void {
  if (Array.isArray(document)) {
    for (const item of document) collectDocument(values, item);
    return;
  }
  if (!document || typeof document !== "object") return;
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    if (typeof value === "string") {
      if (key === "buyer_id" || key === "user_id" || key === "account_id" || key === "owner_account_id") collect(values, "account", value);
      else if (key === "creator_id") collect(values, "creator", value);
      else if (key === "product_id" || key === "agent_id") collect(values, "product", value);
      else if (key === "order_id") collect(values, "order", value);
      else if (key === "entitlement_id") collect(values, "entitlement", value);
    }
    collectDocument(values, value);
  }
}

async function existingTables(db: IdentityMigrationExecutor): Promise<Set<string>> {
  const result = await db.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])`, [[
    "accounts", "account_sessions", "agent_access", "commerce_events", "commerce_outbox",
    "commerce_inbox", "commerce_read_models", "commerce_read_model_state", "portal_workflow_state",
    "hatch_conversations", "tool_connections", "agent_tool_bindings", "hatch_creator_factory_runs"
  ]]);
  return new Set((result.rows ?? []).map((row) => String(row.table_name)));
}

async function mappingFor(db: IdentityMigrationExecutor, kind: IdentityKind, legacyId: string): Promise<string> {
  const existing = await db.query(
    "SELECT uuid FROM uuid_identity_migrations WHERE kind=$1 AND legacy_id=$2",
    [kind, legacyId]
  );
  if (existing.rows?.[0]?.uuid && isUuidV4(String(existing.rows[0].uuid))) return String(existing.rows[0].uuid).toLowerCase();
  const known = kind === "creator"
    ? KNOWN_CREATORS.get(legacyId)
    : kind === "product"
      ? KNOWN_PRODUCTS.get(legacyId)
        ?? [...KNOWN_PRODUCTS.entries()].find(([key]) => key.endsWith(`\u0000${legacyId}`))?.[1]
      : undefined;
  if (known) {
    await db.query(
      "INSERT INTO uuid_identity_migrations (kind, legacy_id, uuid) VALUES ($1,$2,$3) ON CONFLICT (kind, legacy_id) DO NOTHING",
      [kind, legacyId, known]
    );
    return known;
  }
  if (kind === "creator" || kind === "product") {
    throw new Error(`UUID cutover cannot infer a ${kind} identity for legacy value ${legacyId}`);
  }
  const uuid = randomUUID();
  await db.query(
    "INSERT INTO uuid_identity_migrations (kind, legacy_id, uuid) VALUES ($1,$2,$3) ON CONFLICT (kind, legacy_id) DO NOTHING",
    [kind, legacyId, uuid]
  );
  const replay = await db.query(
    "SELECT uuid FROM uuid_identity_migrations WHERE kind=$1 AND legacy_id=$2",
    [kind, legacyId]
  );
  return String(replay.rows?.[0]?.uuid ?? uuid).toLowerCase();
}

function rewriteDocument(document: unknown, mappings: Map<string, string>, parentKey = ""): unknown {
  if (Array.isArray(document)) return document.map((item) => rewriteDocument(item, mappings, parentKey));
  if (!document || typeof document !== "object") return document;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(document as Record<string, unknown>)) {
    let next = value;
    if (typeof value === "string") {
      const kind = identityKindForKey(key);
      if (kind) next = mappings.get(`${kind}\u0000${value.trim()}`) ?? value;
    }
    output[key] = rewriteDocument(next, mappings, key || parentKey);
  }
  return output;
}

function identityKindForKey(key: string): IdentityKind | undefined {
  if (key === "buyer_id" || key === "user_id" || key === "account_id" || key === "owner_account_id") return "account";
  if (key === "creator_id") return "creator";
  if (key === "product_id" || key === "agent_id") return "product";
  if (key === "order_id") return "order";
  if (key === "entitlement_id") return "entitlement";
  return undefined;
}

async function rewriteJsonTables(db: IdentityMigrationExecutor, tables: Set<string>, mappings: Map<string, string>): Promise<void> {
  if (tables.has("commerce_events")) {
    const rows = await db.query("SELECT sequence, payload FROM commerce_events");
    for (const row of rows.rows ?? []) await db.query("UPDATE commerce_events SET payload=$1::jsonb WHERE sequence=$2", [JSON.stringify(rewriteDocument(row.payload, mappings)), row.sequence]);
  }
  if (tables.has("commerce_outbox")) {
    const rows = await db.query("SELECT outbox_id, payload FROM commerce_outbox");
    for (const row of rows.rows ?? []) await db.query("UPDATE commerce_outbox SET payload=$1::jsonb WHERE outbox_id=$2", [JSON.stringify(rewriteDocument(row.payload, mappings)), row.outbox_id]);
  }
  if (tables.has("commerce_inbox")) {
    const rows = await db.query("SELECT consumer_name, idempotency_key, payload, result FROM commerce_inbox");
    for (const row of rows.rows ?? []) await db.query(
      "UPDATE commerce_inbox SET payload=$1::jsonb, result=$2::jsonb WHERE consumer_name=$3 AND idempotency_key=$4",
      [JSON.stringify(rewriteDocument(row.payload, mappings)), row.result == null ? null : JSON.stringify(rewriteDocument(row.result, mappings)), row.consumer_name, row.idempotency_key]
    );
  }
  if (tables.has("portal_workflow_state")) {
    const rows = await db.query("SELECT singleton, state FROM portal_workflow_state WHERE singleton=TRUE");
    for (const row of rows.rows ?? []) await db.query("UPDATE portal_workflow_state SET state=$1::jsonb WHERE singleton=$2", [JSON.stringify(rewriteDocument(row.state, mappings)), row.singleton]);
  }
  if (tables.has("commerce_read_models")) {
    const rows = await db.query("SELECT model_type, model_id, buyer_id, creator_id, product_id, order_id, entitlement_id, snapshot FROM commerce_read_models");
    for (const row of rows.rows ?? []) {
      const snapshot = rewriteDocument(row.snapshot, mappings) as Record<string, unknown>;
      const mapped = (kind: IdentityKind, value: unknown) => typeof value === "string"
        ? mappings.get(`${kind}\u0000${value}`) ?? value
        : value;
      await db.query(`UPDATE commerce_read_models
        SET buyer_id=$1, creator_id=$2, product_id=$3, order_id=$4, entitlement_id=$5, snapshot=$6::jsonb
        WHERE model_type=$7 AND model_id=$8`, [
        mapped("account", row.buyer_id), mapped("creator", row.creator_id), mapped("product", row.product_id),
        mapped("order", row.order_id), mapped("entitlement", row.entitlement_id), JSON.stringify(snapshot), row.model_type, row.model_id
      ]);
    }
    if (tables.has("commerce_read_model_state")) {
      await db.query("DELETE FROM commerce_read_models");
      await db.query("DELETE FROM commerce_read_model_state WHERE projection_name='commerce-v2'");
    }
  }
}

async function convertUuidColumns(db: IdentityMigrationExecutor, tables: Set<string>): Promise<void> {
  const types = await db.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE table_schema=current_schema()
      AND table_name = ANY($1::text[])`, [[
    "accounts", "account_sessions", "agent_access", "commerce_read_models", "hatch_conversations",
    "tool_connections", "agent_tool_bindings", "hatch_creator_factory_runs"
  ]]);
  const typeOf = (table: string, column: string) => types.rows?.find((row) => row.table_name === table && row.column_name === column)?.data_type;
  const alter = async (table: string, column: string, nullable = false) => {
    if (!tables.has(table) || typeOf(table, column) === undefined || typeOf(table, column) === "uuid") return;
    await db.query(`ALTER TABLE ${table} ALTER COLUMN ${column} TYPE uuid USING ${column}::uuid`);
    if (nullable) return;
  };
  await alter("accounts", "id");
  await alter("account_sessions", "account_id");
  await alter("agent_access", "entitlement_id");
  await alter("agent_access", "user_id");
  await alter("agent_access", "order_id", true);
  for (const column of ["buyer_id", "creator_id", "product_id", "order_id", "entitlement_id"]) {
    await alter("commerce_read_models", column, true);
  }
  await alter("hatch_conversations", "owner_account_id");
  await alter("hatch_conversations", "creator_id");
  await alter("hatch_conversations", "agent_id");
  await alter("hatch_conversations", "product_id");
  await alter("hatch_conversations", "product_id_at_creation");
  await alter("tool_connections", "tenant_id");
  await alter("agent_tool_bindings", "tenant_id");
  await alter("agent_tool_bindings", "agent_id");
  await alter("hatch_creator_factory_runs", "creator_id");
}
