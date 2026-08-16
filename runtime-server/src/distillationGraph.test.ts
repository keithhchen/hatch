import test from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryDistillationGraphStore,
  deriveRevisionContext,
  type DistillationEvent,
  type ImmutableArtifactRecord,
  type QualityGateAssessment
} from "./creatorLearning/distillationGraph.js";

const artifact: ImmutableArtifactRecord = {
  artifactId: "art_corpus",
  productId: "task_1",
  runId: "distill_1",
  revisionId: "factory_1",
  kind: "corpus_bundle",
  objectKey: "factory-runs/factory_1/candidate/v1.zip",
  sha256: "sha256:" + "a".repeat(64),
  bytes: 12,
  mediaType: "application/zip",
  createdAt: "2026-08-15T00:00:00.000Z"
};

function event(input: Partial<DistillationEvent> & Pick<DistillationEvent, "id" | "eventKey" | "type">): DistillationEvent {
  return {
    sequence: 1,
    productId: "task_1",
    runId: "distill_1",
    actor: "worker",
    parentEventIds: [],
    artifactIds: [],
    payload: {},
    occurredAt: "2026-08-15T00:00:00.000Z",
    ...input
  };
}

test("immutable artifacts and event edges are enforced", async () => {
  const graph = new InMemoryDistillationGraphStore();
  await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.createRevision({ id: "factory_1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.registerArtifact(artifact);
  const retried = await graph.registerArtifact({ ...artifact, createdAt: "2026-08-15T00:00:01.000Z" });
  assert.equal(retried.createdAt, artifact.createdAt);
  await assert.rejects(() => graph.registerArtifact({ ...artifact, sha256: "sha256:" + "b".repeat(64) }), /immutable/);
  await assert.rejects(() => graph.appendEvent({
    ...event({ id: "evt_bad", eventKey: "bad", type: "artifact_emitted", artifactIds: ["missing"] }),
  }), /unknown Artifact/);
  const root = await graph.appendEvent({ ...event({ id: "evt_root", eventKey: "root", type: "revision_created", revisionId: "factory_1" }) });
  const child = await graph.appendEvent({
    ...event({ id: "evt_child", eventKey: "child", type: "artifact_emitted", revisionId: "factory_1", parentEventIds: [root.id], artifactIds: [artifact.artifactId] })
  });
  assert.equal((await graph.appendEvent({
    ...event({ id: "evt_other", eventKey: "child", type: "artifact_emitted", revisionId: "factory_1", parentEventIds: [root.id], artifactIds: [artifact.artifactId] })
  })).id, child.id);
  await assert.rejects(() => graph.appendEvent({ ...event({ id: "evt_orphan", eventKey: "orphan", type: "node_completed", parentEventIds: ["not-there"] }) }), /parent/);
});

test("derived state is reconstructed from events and latest gate assessments", async () => {
  const graph = new InMemoryDistillationGraphStore();
  await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.createRevision({ id: "factory_1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.registerArtifact(artifact);
  await graph.appendEvent({ ...event({ id: "evt_revision", eventKey: "revision", type: "revision_created", revisionId: "factory_1", node: "intake" }) });
  await graph.appendEvent({ ...event({ id: "evt_wait", eventKey: "wait", type: "creator_answers_requested", revisionId: "factory_1", node: "questions" }) });
  await graph.appendEvent({ ...event({ id: "evt_correction", eventKey: "correction", type: "correction_requested", revisionId: "factory_1", node: "calibration" }) });
  const failed: QualityGateAssessment = {
    id: "gate_failed",
    gateKey: "factory_1:regression",
    productId: "task_1",
    runId: "distill_1",
    revisionId: "factory_1",
    name: "regression",
    critical: true,
    status: "failed",
    evidenceArtifactIds: [],
    reason: "boundary failure",
    assessedAt: "2026-08-15T00:01:00.000Z"
  };
  await graph.recordGate(failed);
  const state = await graph.derive("task_1");
  assert.equal(state.status, "needs_correction");
  assert.equal(state.currentRevisionId, "factory_1");
  assert.deepEqual(state.criticalGateFailures, ["regression"]);
});

test("a new revision clears stale gates and an immutable release is revision-scoped", async () => {
  const graph = new InMemoryDistillationGraphStore();
  await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.createRevision({ id: "factory_1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.createRevision({ id: "factory_2", runId: "distill_1", productId: "task_1", revision: 2, sourceSnapshotId: "snapshot_2", parentRevisionId: "factory_1", createdAt: "2026-08-15T00:01:00.000Z" });
  await graph.registerArtifact({ ...artifact, artifactId: "art_corpus_2", revisionId: "factory_2" });
  await graph.appendEvent({ ...event({ id: "e1", eventKey: "e1", type: "revision_created", revisionId: "factory_1" }) });
  await graph.appendEvent({ ...event({ id: "e2", eventKey: "e2", type: "gate_assessed", revisionId: "factory_1", node: "regression_eval", artifactIds: [] }) });
  await graph.recordGate({ id: "g1", gateKey: "factory_1:regression", productId: "task_1", runId: "distill_1", revisionId: "factory_1", name: "regression", critical: true, status: "failed", evidenceArtifactIds: [], assessedAt: "2026-08-15T00:00:10.000Z" });
  await graph.appendEvent({ ...event({ id: "e3", eventKey: "e3", type: "revision_created", revisionId: "factory_2" }) });
  await graph.appendEvent({ ...event({ id: "e4", eventKey: "e4", type: "revision_ready", revisionId: "factory_2", node: "release" }) });
  await graph.recordGate({ id: "g2", gateKey: "factory_2:heldout", productId: "task_1", runId: "distill_1", revisionId: "factory_2", name: "heldout", critical: true, status: "passed", evidenceArtifactIds: ["art_corpus_2"], assessedAt: "2026-08-15T00:01:30.000Z" });
  // A late worker retry from v1 must not move the Product's current revision
  // backwards after v2 has been created.
  await graph.appendEvent({ ...event({ id: "e5", eventKey: "e5", type: "node_failed", revisionId: "factory_1", node: "regression_eval" }) });
  // Source Library uploads are Product-scoped and may arrive after a revision;
  // they must not replace the stable Distillation Run identity in derived UI.
  await graph.appendEvent({ ...event({ id: "e6", eventKey: "e6", type: "source_uploaded", runId: "task_1", node: "intake" }) });
  const state = await graph.derive("task_1");
  assert.equal(state.runId, "distill_1");
  assert.equal(state.currentRevisionId, "factory_2");
  assert.equal(state.status, "ready");
  assert.deepEqual(state.criticalGateFailures, []);
  const release = await graph.recordRelease({ id: "release_1", productId: "task_1", runId: "distill_1", revisionId: "factory_2", corpusArtifactId: "art_corpus_2", createdAt: "2026-08-15T00:02:00.000Z" });
  assert.equal((await graph.recordRelease(release)).id, "release_1");
  assert.equal((await graph.derive("task_1")).status, "released");
});

test("re-ensuring a stable Run identity preserves its original timestamp", async () => {
  const graph = new InMemoryDistillationGraphStore();
  const first = await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  const reused = await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:01:00.000Z" });
  assert.equal(reused.createdAt, first.createdAt);
  await graph.createRevision({ id: "factory_2", runId: "distill_1", productId: "task_1", revision: 2, sourceSnapshotId: "snapshot_2", createdAt: "2026-08-15T00:01:00.000Z" });
});

test("gate retries are idempotent across persistence property order", async () => {
  const graph = new InMemoryDistillationGraphStore();
  await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await graph.createRevision({ id: "factory_1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" });
  const first = await graph.recordGate({
    id: "gate_1",
    gateKey: "factory_1:development",
    productId: "task_1",
    runId: "distill_1",
    revisionId: "factory_1",
    name: "development",
    critical: true,
    status: "passed",
    evidenceArtifactIds: [],
    assessedAt: "2026-08-15T00:01:00.000Z"
  });
  const retried = await graph.recordGate({
    id: first.id,
    status: first.status,
    evidenceArtifactIds: first.evidenceArtifactIds,
    critical: first.critical,
    name: first.name,
    revisionId: first.revisionId,
    runId: first.runId,
    productId: first.productId,
    gateKey: first.gateKey,
    assessedAt: first.assessedAt
  });
  assert.deepEqual(retried, first);
});

test("revision context is n-1 plus current feedback plus cumulative regression", () => {
  const revisions = [
    { id: "r1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" },
    { id: "r2", runId: "distill_1", productId: "task_1", revision: 2, sourceSnapshotId: "snapshot_2", parentRevisionId: "r1", createdAt: "2026-08-15T00:01:00.000Z" }
  ];
  const events = [
    event({ id: "e1", eventKey: "e1", type: "node_completed", revisionId: "r1", node: "corpus", artifactIds: ["art_corpus"] }),
    event({ id: "e0", eventKey: "e0", sequence: 0, type: "gate_assessed", revisionId: "r1", node: "regression_eval", artifactIds: ["regression_0"] }),
    event({ id: "e2", eventKey: "e2", type: "correction_submitted", revisionId: "r2", node: "calibration", artifactIds: ["feedback_1"] }),
    event({ id: "e3", eventKey: "e3", type: "gate_assessed", revisionId: "r2", node: "regression_eval", artifactIds: ["regression_1", "feedback_1"] })
  ];
  const context = deriveRevisionContext(revisions[1]!, revisions, events, [artifact]);
  assert.equal(context.parentCorpusArtifactId, "art_corpus");
  assert.deepEqual(context.currentLoopFeedbackArtifactIds, ["feedback_1"]);
  assert.deepEqual(context.cumulativeRegressionArtifactIds, ["regression_0", "regression_1", "feedback_1"]);
});

test("graph records cannot cross product, run, or revision boundaries", async () => {
  const graph = new InMemoryDistillationGraphStore();
  await graph.ensureRun({ id: "distill_1", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await assert.rejects(
    () => graph.ensureRun({ id: "distill_2", productId: "task_1", creatorId: "creator_1", createdAt: "2026-08-15T00:00:00.000Z" }),
    /already attached/
  );
  await graph.createRevision({ id: "factory_1", runId: "distill_1", productId: "task_1", revision: 1, sourceSnapshotId: "snapshot_1", createdAt: "2026-08-15T00:00:00.000Z" });
  await assert.rejects(
    () => graph.recordGate({ id: "bad_gate", gateKey: "bad", productId: "task_1", runId: "other_run", revisionId: "factory_1", name: "schema", critical: true, status: "pending", evidenceArtifactIds: [] }),
    /invalid RunRevision/
  );
});
