import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PortalStateStore } from "../portalState.mjs";

test("Portal state permanently removes pre-cutover Offer fields when opened", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-portal-offer-cutover-"));
  const filePath = path.join(directory, "portal.json");
  await writeFile(filePath, JSON.stringify({
    contract_version: "1",
    checkout_sessions: {
      checkout_legacy: {
        checkout_session_id: "checkout_legacy",
        offer_snapshot: { offer_id: "offer_legacy", revision: 3 },
        quote_change: { previous: 0, current: 4900 }
      }
    },
    creator_products: {
      "creator:product": {
        status: "offer_required",
        offer_draft: { revision: 3 },
        offer_active: { revision: 2 },
        publish_operation: { operation_id: "publish_legacy", offer_revision: 3, offer_activated_at: "2026-01-01T00:00:00.000Z" }
      }
    }
  }), "utf8");

  const store = await PortalStateStore.open({ filePath });
  assert.equal(store.getCheckoutSession("checkout_legacy").offer_snapshot, undefined);
  const persisted = await readFile(filePath, "utf8");
  assert.doesNotMatch(persisted, /offer_snapshot|quote_change|offer_draft|offer_active|offer_revision|offer_activated_at|offer_required/);
  assert.match(persisted, /ready_to_preview/);
});

test("Portal state persists checkout sessions and replays request keys", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-portal-state-"));
  const filePath = path.join(directory, "portal.json");
  const store = await PortalStateStore.open({ filePath });
  const first = await store.createCheckoutSession({
    buyer_id: "buyer-1",
    request_key: "request-1",
    product: { product_id: "product-1" },
    totals: { total_minor: 0, currency: "USD" }
  });
  const replay = await store.createCheckoutSession({
    buyer_id: "buyer-1",
    request_key: "request-1",
    product: { product_id: "ignored" }
  });
  assert.equal(replay.checkout_session_id, first.checkout_session_id);

  const reopened = await PortalStateStore.open({ filePath });
  assert.equal(reopened.getCheckoutSession(first.checkout_session_id).product.product_id, "product-1");

  const concurrent = await Promise.all(Array.from({ length: 8 }, () => store.createCheckoutSession({
    buyer_id: "buyer-concurrent",
    request_key: "request-concurrent",
    product: { product_id: "product-concurrent" },
    totals: { total_minor: 0, currency: "USD" }
  })));
  assert.equal(new Set(concurrent.map((session) => session.checkout_session_id)).size, 1);
});

test("Expired checkout sessions are rejected before any Commerce mutation can begin", async () => {
  let now = new Date("2026-08-01T00:00:00.000Z");
  const store = await PortalStateStore.open({ clock: () => now });
  const session = await store.createCheckoutSession({
    buyer_id: "buyer-expired",
    request_key: "expired-request",
    product: { product_id: "product-expired" },
    totals: { total_minor: 0, currency: "USD" }
  });
  now = new Date("2026-08-01T00:31:00.000Z");
  assert.equal(store.getCheckoutSession(session.checkout_session_id).status, "expired");
  await assert.rejects(
    store.completeCheckout(session.checkout_session_id, { order_id: "must-not-exist" }),
    (error) => error.code === "checkout_expired"
  );
});

test("Factory draft saves replay lost responses and reject changed payloads under one command key", async () => {
  const store = await PortalStateStore.open();
  const content = {
    task_name: "Durable review",
    task_brief: "Return a finished review.",
    sources: [{ id: "S1", title: "Source", authority: "private_material", content: "Evidence" }]
  };
  const saved = await store.saveFactoryDraft("creator-draft", "default", content, 0, "draft-save-1");
  const replay = await store.saveFactoryDraft("creator-draft", "default", content, 0, "draft-save-1");
  assert.equal(replay.version, saved.version);
  const recoveredWithFreshTransportKey = await store.saveFactoryDraft(
    "creator-draft",
    "default",
    content,
    0,
    "draft-save-after-response-loss"
  );
  assert.equal(recoveredWithFreshTransportKey.version, saved.version);
  await assert.rejects(
    store.saveFactoryDraft(
      "creator-draft",
      "default",
      { ...content, task_brief: "Changed content" },
      0,
      "draft-save-1"
    ),
    (error) => error.code === "idempotency_conflict"
  );
});

test("Creator approval and publish form one versioned workflow", async () => {
  const store = await PortalStateStore.open();
  const approved = await store.approveCandidate("creator-1", "product-1", {
    candidate_id: "candidate-1",
    digest: "sha256:candidate"
  }, 0);
  assert.equal(approved.status, "ready_to_preview");

  await assert.rejects(
    store.publishProduct("creator-1", "product-1", { candidate_id: "candidate-other", expected_version: approved.version }),
    (error) => error.code === "candidate_changed"
  );
  const published = await store.publishProduct("creator-1", "product-1", {
    candidate_id: "candidate-1",
    expected_version: approved.version
  });
  assert.equal(published.status, "published");
  assert.match(published.public_url, /^\/products\//);
  const withdrawn = await store.withdrawProduct("creator-1", "product-1", published.version, {
    reason: "Pause the listing for review.",
    command_key: "withdraw-command-1"
  });
  const withdrawReplay = await store.withdrawProduct("creator-1", "product-1", published.version, {
    reason: "Pause the listing for review.",
    command_key: "withdraw-command-1"
  });
  assert.equal(withdrawReplay.version, withdrawn.version);
  await assert.rejects(
    store.withdrawProduct("creator-1", "product-1", published.version, {
      reason: "Different reason",
      command_key: "withdraw-command-1"
    }),
    (error) => error.code === "idempotency_conflict"
  );
});

test("Candidate decisions replay the same durable command and reject changed intent", async () => {
  const store = await PortalStateStore.open();
  const candidate = {
    candidate_id: "candidate-idempotent",
    digest: "sha256:candidate-idempotent",
    report_digest: "sha256:report-idempotent"
  };
  const approved = await store.approveCandidate("creator-command", "product-command", candidate, 0, {
    command_key: "approve-command-1",
    acknowledgements: ["loss-1"],
    reason: "reviewed_evidence"
  });
  const replay = await store.approveCandidate("creator-command", "product-command", candidate, 0, {
    command_key: "approve-command-1",
    acknowledgements: ["loss-1"],
    reason: "reviewed_evidence"
  });
  assert.equal(replay.version, approved.version);
  assert.equal(replay.audit_log.filter((entry) => entry.action === "candidate.approved").length, 1);
  await assert.rejects(
    store.approveCandidate("creator-command", "product-command", candidate, 0, {
      command_key: "approve-command-1",
      acknowledgements: ["loss-1", "loss-2"],
      reason: "reviewed_evidence"
    }),
    (error) => error.code === "idempotency_conflict"
  );
});

test("Publish intent locks the candidate and resumes one durable release", async () => {
  const store = await PortalStateStore.open();
  const approved = await store.approveCandidate("creator-saga", "product-saga", {
    candidate_id: "candidate-saga",
    digest: "sha256:candidate-saga",
    report_digest: "sha256:report-saga"
  }, 0);
  const input = {
    candidate_id: "candidate-saga",
    expected_version: approved.version,
    reason: "publish_reviewed_candidate",
    command_key: "publish-command-1"
  };

  const pending = await store.beginPublishProduct("creator-saga", "product-saga", input);
  assert.equal(pending.status, "publishing");
  assert.ok(pending.publish_operation.operation_id);
  const resumed = await store.beginPublishProduct("creator-saga", "product-saga", input);
  assert.equal(resumed.publish_operation.operation_id, pending.publish_operation.operation_id);
  await assert.rejects(
    store.beginPublishProduct("creator-saga", "product-saga", { ...input, reason: "changed_reason" }),
    (error) => error.code === "idempotency_conflict"
  );

  const published = await store.completePublishProduct(
    "creator-saga",
    "product-saga",
    pending.publish_operation.operation_id
  );
  assert.equal(published.status, "published");
  assert.equal(published.release.release_id, pending.publish_operation.release_id);
  assert.equal(published.release.corpus_digest, "sha256:candidate-saga");
  assert.equal(published.release.report_digest, "sha256:report-saga");
  assert.doesNotThrow(() => store.validatePublishCommand("creator-saga", "product-saga", input));
});

test("Rollback switches immutable release history without rewriting either release", async () => {
  const store = await PortalStateStore.open();
  let state = await store.approveCandidate("creator-history", "product-history", {
    candidate_id: "candidate-one",
    digest: "sha256:one",
    report_digest: "sha256:report-one"
  }, 0);
  state = await store.publishProduct("creator-history", "product-history", {
    candidate_id: "candidate-one", expected_version: state.version
  });
  const firstRelease = structuredClone(state.release);

  state = await store.approveCandidate("creator-history", "product-history", {
    candidate_id: "candidate-two",
    digest: "sha256:two",
    report_digest: "sha256:report-two"
  }, state.version);
  state = await store.publishProduct("creator-history", "product-history", {
    candidate_id: "candidate-two", expected_version: state.version
  });
  assert.equal(state.releases.length, 2);
  assert.equal(state.release.corpus_digest, "sha256:two");

  const pending = await store.beginRollbackProduct(
    "creator-history",
    "product-history",
    firstRelease.release_id,
    state.version,
    {
      reason: "Restore the stable Corpus after review.",
      command_key: "rollback-command-1"
    }
  );
  const rolledBack = await store.completeRollbackProduct(
    "creator-history",
    "product-history",
    pending.rollback_operation.operation_id
  );
  assert.equal(rolledBack.release.release_id, firstRelease.release_id);
  assert.equal(rolledBack.release.corpus_digest, "sha256:one");
  assert.deepEqual(rolledBack.releases.map((release) => release.corpus_digest), ["sha256:one", "sha256:two"]);
  assert.equal(rolledBack.releases.filter((release) => release.current).length, 1);
  assert.throws(
    () => store.validateRollbackCommand(
      "creator-history",
      "product-history",
      firstRelease.release_id,
      state.version,
      {
        reason: "Changed reason",
        command_key: "rollback-command-1"
      }
    ),
    (error) => error.code === "idempotency_conflict"
  );
});
