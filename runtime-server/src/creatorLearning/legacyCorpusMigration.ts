import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RegistryStoreTs } from "../registryStore.js";
import type { PostgresNodeStore } from "../nodeSession.js";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { CorpusPublisher } from "./corpusPublisher.js";
import type { CreatorRegistryReleaseStore } from "./creatorRegistryRelease.js";
import type { PostgresQueryExecutor } from "../postgresStore.js";

const SETH_CREATOR_ID = "32ffccf7-893d-4ef3-bdbc-c82fc8fcb90b";
const SETH_PRODUCT_ID = "026651b1-8a8a-4484-aac5-ace6bd662157";
const MIGRATION_EXECUTION_ID = "legacy-seth-corpus-v1";

/**
 * Converts the shipped legacy Seth bundle into the same Node output consumed
 * by every other Product. This is deliberately a data migration boundary:
 * after it succeeds, public reads and Runtime use only Registry releases.
 */
export async function migrateSethToNodeCorpus(input: {
  registry: RegistryStoreTs;
  nodes: PostgresNodeStore;
  objects: ArtifactObjectStore;
  publisher: CorpusPublisher;
  releases: CreatorRegistryReleaseStore;
  productPool: PostgresQueryExecutor;
}): Promise<boolean> {
  const live = await input.releases.getLive(SETH_PRODUCT_ID);
  const legacy = input.registry.getAgentCorpus(SETH_CREATOR_ID, SETH_PRODUCT_ID);
  if (!legacy) return false;

  const bundleRoot = input.registry.corpusPath(SETH_CREATOR_ID, SETH_PRODUCT_ID);
  const legacyManifest = await readLegacyManifest(path.join(bundleRoot, "agent.json"));
  const productName = legacyManifest?.product?.name || legacy.product_name;
  const productPromise = legacyManifest?.product?.description || legacy.product_promise || legacy.product_description || productName;
  const briefSpec = legacy.brief_spec;
  await input.productPool.query(`
    INSERT INTO hatch_creator_products (id, creator_id, name, promise, brief_spec, status)
    VALUES ($1, $2, $3, $4, $5::jsonb, 'active')
    ON CONFLICT (id) DO UPDATE SET
      creator_id=EXCLUDED.creator_id,
      name=EXCLUDED.name,
      promise=EXCLUDED.promise,
      status='active',
      updated_at=clock_timestamp()
  `, [SETH_PRODUCT_ID, SETH_CREATOR_ID, productName, productPromise, JSON.stringify(briefSpec ?? null)]);

  if (live && await releaseHasCurrentProduct(input.objects, live.runtime_manifest_ref, productName, productPromise)) return false;

  const systemPath = path.join(bundleRoot, "instructions", "system.md");
  const systemInstructions = await readFile(systemPath, "utf8");
  const output = {
    system_instructions: systemInstructions,
    skills: [],
    knowledge: []
  };
  const outputRef = `${SETH_PRODUCT_ID}/corpus/${MIGRATION_EXECUTION_ID}/output.json`;
  await input.objects.put(outputRef, `${JSON.stringify(output, null, 2)}\n`, {
    immutable: true,
    contentType: "application/json"
  });
  await input.nodes.save({
    scope: {
      productId: SETH_PRODUCT_ID,
      nodeName: "corpus",
      executionId: MIGRATION_EXECUTION_ID
    }
  }, {
    status: "completed",
    round: 1,
    outputRef,
    decision: "done",
    details: { migration: "legacy-agent-corpus-v1", source: "agent-corpora" }
  });
  await input.publisher.publishLatest({
    creatorId: SETH_CREATOR_ID,
    productId: SETH_PRODUCT_ID,
    productName,
    productPromise,
    briefSpec,
    force: Boolean(live)
  });
  return true;
}

async function readLegacyManifest(file: string): Promise<{ product?: { name?: string; description?: string } } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const product = (parsed as { product?: unknown }).product;
    if (!product || typeof product !== "object") return undefined;
    const row = product as { name?: unknown; description?: unknown };
    return {
      product: {
        ...(typeof row.name === "string" ? { name: row.name.trim() } : {}),
        ...(typeof row.description === "string" ? { description: row.description.trim() } : {})
      }
    };
  } catch {
    return undefined;
  }
}

async function releaseHasCurrentProduct(objects: ArtifactObjectStore, ref: string, name: string, promise: string): Promise<boolean> {
  try {
    const parsed = JSON.parse((await objects.get(ref)).toString("utf8")) as { product?: { name?: unknown; promise?: unknown } };
    return parsed.product?.name === name && parsed.product?.promise === promise;
  } catch {
    return false;
  }
}

export const sethMigrationIds = {
  creatorId: SETH_CREATOR_ID,
  productId: SETH_PRODUCT_ID,
  executionId: MIGRATION_EXECUTION_ID
} as const;
