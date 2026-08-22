import path from "node:path";
import { Pool } from "pg";
import { CreatorRegistryReleaseStore } from "./creatorLearning/creatorRegistryRelease.js";
import { migrateKnowledgeTitles } from "./creatorLearning/knowledgeTitleMigration.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { QdrantKnowledgeIndexer } from "./qdrantIndexer.js";

/**
 * Boundary between the production entrypoint and the Knowledge title
 * migration implementation.  The implementation lives in
 * knowledgeTitleMigration.ts; this CLI only wires production dependencies.
 *
 * `verifyOnly` is used by deploy after the migration to validate every live
 * release without writing anything.
 */
const verifyOnly = parseArguments(process.argv.slice(2));
const environment = process.env;
const databaseUrl = environment.HATCH_REGISTRY_DATABASE_URL?.trim() || environment.HATCH_DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("HATCH_REGISTRY_DATABASE_URL is required");

const objectStore = objectStoreFromEnvironment(environment);
if (!objectStore) throw new Error("Production Knowledge title migration requires the configured object store");

const runtimeCorpusRoot = environment.HATCH_RUNTIME_CORPUS_ROOT?.trim();
if (!runtimeCorpusRoot) throw new Error("HATCH_RUNTIME_CORPUS_ROOT is required");
const knowledgeIndexer = QdrantKnowledgeIndexer.fromEnvironment(environment);

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: positiveInteger(environment.HATCH_REGISTRY_DB_TIMEOUT_MS, 5_000),
  query_timeout: positiveInteger(environment.HATCH_REGISTRY_DB_TIMEOUT_MS, 5_000),
  statement_timeout: positiveInteger(environment.HATCH_REGISTRY_DB_TIMEOUT_MS, 5_000),
  idleTimeoutMillis: 30_000,
});

try {
  const releaseStore = new CreatorRegistryReleaseStore(pool);
  await releaseStore.ensureSchema();
  const result = await migrateKnowledgeTitles({
    objectStore,
    releaseStore,
    runtimeCorpusRoot: path.resolve(runtimeCorpusRoot),
    ...(knowledgeIndexer ? { knowledgeIndexer } : {}),
    ...(verifyOnly ? { verifyOnly: true } : {}),
  });
  process.stdout.write(`${JSON.stringify({ mode: verifyOnly ? "verify" : "migrate", result })}\n`);
} finally {
  await pool.end();
}

function parseArguments(arguments_: string[]): boolean {
  if (arguments_.length === 0) return false;
  if (arguments_.length === 1 && arguments_[0] === "--verify") return true;
  throw new Error("Usage: npm run migrate:knowledge-title [-- --verify]");
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 250 || value > 120_000) {
    throw new Error("HATCH_REGISTRY_DB_TIMEOUT_MS must be an integer between 250 and 120000");
  }
  return value;
}
