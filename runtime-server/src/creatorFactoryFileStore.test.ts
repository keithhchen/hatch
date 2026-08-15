import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { InMemoryDistillationGraphStore } from "./creatorLearning/distillationGraph.js";
import { FactoryFileStore } from "./creatorLearning/fileStore.js";

test("Factory graph retry identity includes immutable report artifacts", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-factory-graph-retry-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const graph = new InMemoryDistillationGraphStore();
  const taskId = "task_graph_retry";
  const runId = "run_graph_retry";
  const revisionId = "revision_graph_retry";
  await graph.ensureRun({
    id: runId,
    taskId,
    creatorId: "creator_graph_retry",
    productId: "product_graph_retry",
    createdAt: "2026-08-16T00:00:00.000Z"
  });
  await graph.createRevision({
    id: revisionId,
    runId,
    taskId,
    revision: 1,
    sourceSnapshotId: "snapshot_graph_retry",
    createdAt: "2026-08-16T00:00:00.000Z"
  });

  const store = new FactoryFileStore(root, runId, undefined, undefined, {
    graphStore: graph,
    graphContext: { taskId, runId, revisionId }
  });
  await store.initialize();
  const firstReport = await store.writeArtifact("evaluations/corpus-guard-v1.json", "first report");
  const secondReport = await store.writeArtifact("evaluations/corpus-guard-v2.json", "second report");

  const details = (report: typeof firstReport) => ({
    stage: "compiling_corpus",
    report,
    outputArtifactIds: [report.artifactId],
    attempt: 1
  });
  await store.recordEvent("corpus_release_guard_failed", details(firstReport));
  await store.recordEvent("corpus_release_guard_failed", details(secondReport));
  // Replaying the same immutable report remains idempotent.
  await store.recordEvent("corpus_release_guard_failed", details(secondReport));

  const failures = (await graph.listEvents(taskId)).filter((event) => event.type === "node_failed");
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((event) => event.artifactIds), [[firstReport.artifactId], [secondReport.artifactId]]);
});
