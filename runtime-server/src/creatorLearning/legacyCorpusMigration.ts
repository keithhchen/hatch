import { readFile } from "node:fs/promises";
import path from "node:path";
import type { RegistryStoreTs } from "../registryStore.js";
import type { PostgresNodeStore } from "../nodeSession.js";
import type { ArtifactObjectStore } from "./objectStore.js";
import type { CorpusPublisher } from "./corpusPublisher.js";
import type { CreatorRegistryReleaseStore } from "./creatorRegistryRelease.js";

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
}): Promise<boolean> {
  const live = await input.releases.getLive(SETH_PRODUCT_ID);
  if (live) return false;

  const legacy = input.registry.getAgentCorpus(SETH_CREATOR_ID, SETH_PRODUCT_ID);
  if (!legacy) return false;

  const systemPath = path.join(input.registry.corpusPath(SETH_CREATOR_ID, SETH_PRODUCT_ID), "instructions", "system.md");
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
    productName: legacy.product_name,
    productPromise: legacy.product_promise ?? legacy.product_description ?? legacy.product_name,
    briefSpec: legacy.brief_spec
  });
  return true;
}

export const sethMigrationIds = {
  creatorId: SETH_CREATOR_ID,
  productId: SETH_PRODUCT_ID,
  executionId: MIGRATION_EXECUTION_ID
} as const;
