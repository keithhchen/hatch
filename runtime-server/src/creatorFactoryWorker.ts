import "dotenv/config";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createHatchCliCandidateExecutor } from "./creatorLearning/cliCandidateExecutor.js";
import { CreatorFactory } from "./creatorLearning/engine.js";
import { PI_FACTORY_MODEL, runFactoryPromptWithPi } from "./creatorLearning/piGateway.js";
import { PostgresCreatorFactoryRepository } from "./creatorLearning/repository.js";
import { CreatorFactoryWorker } from "./creatorLearning/worker.js";
import { objectStoreFromEnvironment } from "./creatorLearning/objectStore.js";
import { PostgresDistillationGraphStore } from "./creatorLearning/distillationGraphStore.js";
import { writeOperationalError } from "./operationalLogging.js";

export async function runCreatorFactoryWorker(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
  const repository = new PostgresCreatorFactoryRepository({ environment });
  await repository.initialize();
  const factoryRoot = path.resolve(environment.HATCH_CREATOR_FACTORY_ROOT ?? "creator-factory-runs");
  const objectStore = objectStoreFromEnvironment(environment);
  const graphStore = new PostgresDistillationGraphStore(repository.pool);
  await graphStore.initialize();
  const factory = new CreatorFactory(
    factoryRoot,
    runFactoryPromptWithPi,
    createHatchCliCandidateExecutor({
      timeoutMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_HATCH_TIMEOUT_MS, 15 * 60_000),
      environment
    }),
    { model: PI_FACTORY_MODEL, objectStore, graphStore }
  );
  const worker = new CreatorFactoryWorker(repository, factory, {
    workerId: environment.HATCH_CREATOR_FACTORY_WORKER_ID?.trim() || `factory-${process.pid}-${randomUUID()}`,
    // Keep the lease above the Factory LLM's 15-minute hard deadline. A
    // recovery worker must not reclaim a live direct execution merely because
    // one provider turn is slow.
    leaseMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_LEASE_MS, 20 * 60_000),
    heartbeatMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_HEARTBEAT_MS, 60_000)
  });
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await worker.runUntilStopped({
      pollMs: integerEnvironment(environment.HATCH_CREATOR_FACTORY_POLL_MS, 1_000),
      signal: controller.signal
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await repository.close();
  }
}

function integerEnvironment(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`Expected a positive integer, received ${raw}`);
  return value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCreatorFactoryWorker().catch((error) => {
    writeOperationalError("creator_factory_worker_failed", error);
    process.exitCode = 1;
  });
}
