import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PortalStateStore } from "../portalState.mjs";

test("R14 concurrent Factory autosaves reject the stale tab and never overwrite the winner", async () => {
  const store = await PortalStateStore.open();
  const creatorId = "creator-r14";
  const draftId = "two-tab-draft";
  const initial = store.getFactoryDraft(creatorId, draftId);
  const firstTab = {
    task_name: "First tab's reviewed title",
    task_brief: "The first browser tab completed this edit.",
    sources: [{ id: "S1", title: "First", authority: "private_material", content: "winner" }]
  };
  const staleTab = {
    task_name: "Stale tab's title",
    task_brief: "This edit was based on the same old version.",
    sources: [{ id: "S1", title: "Stale", authority: "private_material", content: "must not overwrite" }]
  };

  const outcomes = await Promise.allSettled([
    store.saveFactoryDraft(creatorId, draftId, firstTab, initial.version),
    store.saveFactoryDraft(creatorId, draftId, staleTab, initial.version)
  ]);

  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  const conflict = outcomes.find(({ status }) => status === "rejected");
  assert.equal(conflict?.reason?.code, "stale_version");
  assert.equal(conflict?.reason?.status, 409);
  assert.match(conflict?.reason?.message, /another tab/i);

  const winner = outcomes.find(({ status }) => status === "fulfilled")?.value;
  const persisted = store.getFactoryDraft(creatorId, draftId);
  assert.equal(persisted.version, initial.version + 1);
  assert.deepEqual(persisted, winner);
  assert.equal(persisted.task_name, firstTab.task_name);
  assert.notEqual(persisted.task_name, staleTab.task_name);
  assert.equal(persisted.sources[0].content, "winner");
});

test("R17 changed candidate digest or report stales the old approval and requires a fresh review before publish", async () => {
  const store = await PortalStateStore.open();
  const creatorId = "creator-r17";
  const productId = "candidate-freshness";
  const candidateV1 = {
    candidate_id: "factory_candidate_r17",
    digest: "sha256:r17-corpus-v1",
    report_digest: "sha256:r17-report-v1"
  };
  const candidateReportV2 = {
    // Factory can rebuild the same logical candidate/run ID, so freshness must
    // bind both immutable digests rather than only the ID.
    candidate_id: candidateV1.candidate_id,
    digest: candidateV1.digest,
    report_digest: "sha256:r17-report-v2"
  };
  const candidateV2 = {
    candidate_id: candidateV1.candidate_id,
    digest: "sha256:r17-corpus-v2",
    report_digest: candidateReportV2.report_digest
  };

  let state = await store.approveCandidate(creatorId, productId, candidateV1, 0, {
    reason: "Review the first candidate assets"
  });
  const stalePublish = await store.beginPublishProduct(creatorId, productId, {
    candidate_id: candidateV1.candidate_id,
    expected_version: state.version,
    reason: "Publish V1"
  });
  const abandonedOperationId = stalePublish.publish_operation.operation_id;

  // A report-only change is enough to invalidate the decision.
  state = await store.markCandidateChanged(creatorId, productId, candidateReportV2, {
    reason: "factory_candidate_changed"
  });
  assert.equal(state.status, "candidate_ready");
  assert.equal(state.publish_operation, undefined);
  assert.equal(state.approval.status, "stale");
  assert.equal(state.approval.candidate_id, candidateV1.candidate_id);
  assert.equal(state.approval.candidate_digest, candidateV1.digest);
  assert.equal(state.approval.report_digest, candidateV1.report_digest);
  assert.equal(state.approval.current_candidate_digest, candidateReportV2.digest);
  assert.equal(state.approval.current_report_digest, candidateReportV2.report_digest);
  const staleAudit = state.audit_log.at(-1);
  assertAuditEnvelope(staleAudit, {
    action: "candidate.approval_stale",
    actorId: creatorId,
    reason: "factory_candidate_changed"
  });
  assert.equal(staleAudit.details.abandoned_publish_operation_id, abandonedOperationId);

  await assert.rejects(
    store.beginPublishProduct(creatorId, productId, {
      candidate_id: candidateReportV2.candidate_id,
      expected_version: state.version
    }),
    (error) => error.code === "candidate_not_approved" && error.status === 409
  );
  assert.equal(store.getCreatorProduct(creatorId, productId).release, undefined);

  state = await store.approveCandidate(creatorId, productId, candidateReportV2, state.version, {
    reason: "Review the rebuilt evaluation report"
  });
  assert.equal(state.status, "ready_to_preview");
  assert.equal(state.approval.status, "approved");
  assert.equal(state.approval.candidate_digest, candidateReportV2.digest);
  assert.equal(state.approval.report_digest, candidateReportV2.report_digest);

  const reportV2Publish = await store.beginPublishProduct(creatorId, productId, {
    candidate_id: candidateReportV2.candidate_id,
    expected_version: state.version,
    reason: "Publish the freshly reviewed report"
  });
  // A corpus-only change independently invalidates the new approval and
  // abandons its in-flight operation as well.
  state = await store.markCandidateChanged(creatorId, productId, candidateV2, {
    reason: "factory_candidate_changed"
  });
  assert.equal(state.approval.status, "stale");
  assert.equal(state.approval.current_candidate_digest, candidateV2.digest);
  assert.equal(state.approval.current_report_digest, candidateV2.report_digest);
  assert.equal(state.publish_operation, undefined);
  assert.equal(
    state.audit_log.at(-1).details.abandoned_publish_operation_id,
    reportV2Publish.publish_operation.operation_id
  );

  state = await store.approveCandidate(creatorId, productId, candidateV2, state.version, {
    reason: "Review the rebuilt candidate assets"
  });
  assert.equal(state.approval.candidate_digest, candidateV2.digest);
  assert.equal(state.approval.report_digest, candidateV2.report_digest);
  const pending = await store.beginPublishProduct(creatorId, productId, {
    candidate_id: candidateV2.candidate_id,
    expected_version: state.version,
    reason: "Publish freshly reviewed V2"
  });
  const published = await store.completePublishProduct(
    creatorId,
    productId,
    pending.publish_operation.operation_id
  );
  assert.equal(published.status, "published");
  assert.equal(published.release.corpus_digest, candidateV2.digest);
  assert.equal(published.release.report_digest, candidateV2.report_digest);
  assert.equal(published.releases.length, 1);
});

test("R18 interrupted publish and rollback resume their durable intent without moving the live pointer early", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-creator-saga-r18-"));
  const filePath = path.join(directory, "portal-state.json");
  const creatorId = "creator-r18";
  const productId = "durable-deployment";
  let store = await PortalStateStore.open({ filePath });

  let state = await reviewAndPublish(store, creatorId, productId, {
    candidate_id: "candidate-v1",
    digest: "sha256:corpus-v1",
    report_digest: "sha256:report-v1"
  }, 0);
  const firstRelease = structuredClone(state.release);

  state = await store.approveCandidate(creatorId, productId, {
    candidate_id: "candidate-v2",
    digest: "sha256:corpus-v2",
    report_digest: "sha256:report-v2"
  }, state.version);
  const publishInput = {
    candidate_id: "candidate-v2",
    expected_version: state.version,
    reason: "Publish reviewed V2"
  };
  const pendingPublish = await store.beginPublishProduct(creatorId, productId, publishInput);
  const publishOperation = structuredClone(pendingPublish.publish_operation);

  // Simulate the process dying after persisting intent but before the Registry
  // side effect and complete transition return.
  store = await PortalStateStore.open({ filePath });
  const afterPublishFailure = store.getCreatorProduct(creatorId, productId);
  assert.equal(afterPublishFailure.status, "publishing");
  assert.equal(afterPublishFailure.release.release_id, firstRelease.release_id);
  assert.equal(afterPublishFailure.releases.length, 1);
  assert.equal(afterPublishFailure.releases[0].current, true);
  const resumedPublish = await store.beginPublishProduct(creatorId, productId, publishInput);
  assert.deepEqual(resumedPublish.publish_operation, publishOperation);
  state = await store.completePublishProduct(creatorId, productId, publishOperation.operation_id);
  assert.equal(state.releases.length, 2);
  assert.equal(state.release.release_id, publishOperation.release_id);
  assert.equal(state.releases.filter((release) => release.current).length, 1);
  const secondRelease = structuredClone(state.release);

  const rollbackInput = {
    reason: "Return to the verified V1 corpus after an external incident."
  };
  const pendingRollback = await store.beginRollbackProduct(
    creatorId,
    productId,
    firstRelease.release_id,
    state.version,
    rollbackInput
  );
  const rollbackOperation = structuredClone(pendingRollback.rollback_operation);

  // A failed Registry activation leaves the newer release live and the same
  // rollback operation can be retried after restart.
  store = await PortalStateStore.open({ filePath });
  const afterRollbackFailure = store.getCreatorProduct(creatorId, productId);
  assert.equal(afterRollbackFailure.status, "rolling_back");
  assert.equal(afterRollbackFailure.release.release_id, secondRelease.release_id);
  assert.equal(afterRollbackFailure.releases.find((release) => release.current)?.release_id, secondRelease.release_id);
  const resumedRollback = await store.beginRollbackProduct(
    creatorId,
    productId,
    firstRelease.release_id,
    pendingRollback.version,
    rollbackInput
  );
  assert.deepEqual(resumedRollback.rollback_operation, rollbackOperation);
  state = await store.completeRollbackProduct(creatorId, productId, rollbackOperation.operation_id);
  assert.equal(state.release.release_id, firstRelease.release_id);
  assert.equal(state.releases.length, 2);
  assert.equal(state.releases.filter((release) => release.current).length, 1);
});

test("stale materialized publish is reconciled only when the existing live release matches", async () => {
  const store = await PortalStateStore.open();
  const creatorId = "creator-stale-materialized";
  const productId = "stale-materialized-product";
  const digest = "sha256:stale-materialized-release";
  await store.seedPublishedProduct(creatorId, productId, {
    creator_id: creatorId,
    product_id: productId,
    agent_id: productId,
    corpus_digest: digest,
    product_name: "Existing release",
    product_description: "Existing release"
  });
  let state = await store.approveCandidate(creatorId, productId, {
    candidate_id: "factory-stale-revision",
    digest,
    report_digest: "sha256:stale-report"
  }, 0);
  state = await store.beginPublishProduct(creatorId, productId, {
    candidate_id: "factory-stale-revision",
    expected_version: state.version,
    command_key: "stale-materialized-publish"
  });
  const operationId = state.publish_operation.operation_id;
  await store.markPublishMaterialized(creatorId, productId, operationId, {
    creator_id: creatorId,
    product_id: productId,
    agent_id: productId,
    corpus_digest: digest
  });

  const reconciled = await store.reconcileStaleMaterializedPublish(
    creatorId,
    productId,
    operationId,
    "registry_rejected_stale_factory_revision"
  );
  assert.equal(reconciled.status, "published");
  assert.equal(reconciled.release.corpus_digest, digest);
  assert.equal(reconciled.publish_operation, undefined);
  assert.equal(reconciled.last_publish_operation.reconciled_at !== undefined, true);
  assert.equal(reconciled.audit_log.at(-1).action, "release.publish_reconciled");
  assert.equal(reconciled.audit_log.at(-1).details.operation_id, operationId);
});

test("R20 rollback rejects incomplete review, records actor and reason, and preserves immutable release snapshots", async () => {
  const store = await PortalStateStore.open();
  const creatorId = "creator-r20";
  const productId = "audited-rollback";
  let state = await reviewAndPublish(store, creatorId, productId, {
    candidate_id: "candidate-r20-v1",
    digest: "sha256:r20-corpus-v1",
    report_digest: "sha256:r20-report-v1"
  }, 0);
  const firstReleaseId = state.release.release_id;
  state = await reviewAndPublish(store, creatorId, productId, {
    candidate_id: "candidate-r20-v2",
    digest: "sha256:r20-corpus-v2",
    report_digest: "sha256:r20-report-v2"
  }, state.version);

  const beforeNegativeChecks = structuredClone(state);
  await assert.rejects(
    store.beginRollbackProduct(creatorId, productId, firstReleaseId, state.version, {
      reason: "   "
    }),
    (error) => error.code === "audit_reason_required" && error.status === 422
  );
  assert.deepEqual(store.getCreatorProduct(creatorId, productId), beforeNegativeChecks);

  const immutableBefore = releaseContents(state.releases);
  const reason = "Restore the incident-reviewed V1 corpus.";
  const pending = await store.beginRollbackProduct(
    creatorId,
    productId,
    firstReleaseId,
    state.version,
    { reason }
  );
  const started = pending.audit_log.at(-1);
  assertAuditEnvelope(started, {
    action: "release.rollback_started",
    actorId: creatorId,
    reason
  });
  assert.equal(started.details.operation_id, pending.rollback_operation.operation_id);
  assert.equal(started.details.release_id, firstReleaseId);

  const completed = await store.completeRollbackProduct(
    creatorId,
    productId,
    pending.rollback_operation.operation_id
  );
  const rolledBack = completed.audit_log.at(-1);
  assertAuditEnvelope(rolledBack, {
    action: "release.rolled_back",
    actorId: creatorId,
    reason
  });
  assert.equal(rolledBack.details.operation_id, pending.rollback_operation.operation_id);
  assert.equal(rolledBack.details.release_id, firstReleaseId);
  assert.deepEqual(releaseContents(completed.releases), immutableBefore);
  assert.equal(completed.release.release_id, firstReleaseId);
  assert.equal(completed.releases.filter((release) => release.current).length, 1);
});

async function reviewAndPublish(store, creatorId, productId, candidate, expectedVersion) {
  let state = await store.approveCandidate(creatorId, productId, candidate, expectedVersion, {
    reason: `Review ${candidate.candidate_id}`
  });
  return store.publishProduct(creatorId, productId, {
    candidate_id: candidate.candidate_id,
    expected_version: state.version
  });
}

function releaseContents(releases) {
  return releases.map(({ current: _current, ...release }) => release);
}

function assertAuditEnvelope(entry, { action, actorId, reason }) {
  assert.equal(entry.schema_version, 1);
  assert.match(entry.audit_id, /^audit_/);
  assert.equal(entry.action, action);
  assert.equal(entry.actor_id, actorId);
  assert.equal(entry.actor_type, "creator");
  assert.equal(entry.service_name, "dashboard-bff");
  assert.equal(entry.tenant_id, actorId);
  assert.equal(entry.aggregate_type, "creator_product");
  assert.equal(typeof entry.aggregate_id, "string");
  assert.equal(typeof entry.correlation_id, "string");
  assert.match(entry.payload_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(entry.reason, reason);
  assert.equal(typeof entry.details, "object");
  assert.ok(Number.isFinite(Date.parse(entry.occurred_at)));
}
