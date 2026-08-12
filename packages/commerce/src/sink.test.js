import assert from "node:assert/strict";
import test from "node:test";
import { CommerceLedger, LedgerCommerceSink, projectCreatorDashboard } from "./index.js";

const identity = {
  buyer_id: "buyer_fixture",
  creator_id: "creator_fixture",
  product_id: "product_fixture",
  agent_id: "agent_fixture",
  corpus_digest: `sha256:${"a".repeat(64)}`
};

async function ledgerThroughArtifact({ grossMinor = 3999 } = {}) {
  const ledger = await CommerceLedger.open();
  const sink = new LedgerCommerceSink(ledger);
  await sink.ingest("order.placed", {
    ...identity,
    order_id: "order_fixture",
    buyer_display_name: "Fixture Buyer",
    product_name: "Fixture Product",
    gross_minor: grossMinor,
    currency: "USD"
  });
  await sink.ingest("entitlement.granted", {
    ...identity,
    order_id: "order_fixture",
    entitlement_id: "entitlement_fixture"
  });
  await sink.ingest("task.started", {
    ...identity,
    order_id: "order_fixture",
    entitlement_id: "entitlement_fixture",
    task_id: "task_fixture"
  });
  await sink.ingest("artifact.created", {
    ...identity,
    order_id: "order_fixture",
    task_id: "task_fixture",
    artifact_id: "artifact_fixture",
    artifact_digest: `sha256:${"b".repeat(64)}`
  });
  return { ledger, sink };
}

test("actual delivery completion recognizes 90/10 revenue for the same Agent", async () => {
  const { ledger, sink } = await ledgerThroughArtifact();
  const result = await sink.ingest("delivery.completed", {
    ...identity,
    order_id: "order_fixture",
    task_id: "task_fixture",
    artifact_id: "artifact_fixture",
    delivery_id: "delivery_fixture"
  });

  assert.equal(result.revenue.gross_minor, 3999);
  assert.equal(result.revenue.hatch_share_minor, 399);
  assert.equal(result.revenue.creator_share_minor, 3600);
  assert.equal(result.revenue.recognition_id, "recognition_delivery_fixture");
  assert.equal(result.revenue.agent_id, identity.agent_id);
  assert.equal(projectCreatorDashboard(ledger.listEvents(), "creator_fixture").metrics.creator_share_minor, 3600);

  await sink.ingest("delivery.completed", {
    ...identity,
    order_id: "order_fixture",
    task_id: "task_fixture",
    artifact_id: "artifact_fixture",
    delivery_id: "delivery_fixture"
  });
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "revenue.recognized").length, 1);
});

test("free delivery completes without creating revenue", async () => {
  const { ledger, sink } = await ledgerThroughArtifact({ grossMinor: 0 });
  const result = await sink.ingest("delivery.completed", {
    ...identity,
    order_id: "order_fixture",
    task_id: "task_fixture",
    artifact_id: "artifact_fixture",
    delivery_id: "delivery_free"
  });

  assert.equal(result.delivery.delivery_id, "delivery_free");
  assert.equal(result.revenue, null);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "revenue.recognized").length, 0);
});

test("identity mismatch cannot cross from entitlement into a task", async () => {
  const ledger = await CommerceLedger.open();
  const sink = new LedgerCommerceSink(ledger);
  await sink.ingest("order.placed", {
    ...identity,
    order_id: "order_fixture",
    gross_minor: 3900,
    currency: "USD"
  });
  await sink.ingest("entitlement.granted", {
    ...identity,
    order_id: "order_fixture",
    entitlement_id: "entitlement_fixture"
  });
  await assert.rejects(
    sink.ingest("task.started", {
      ...identity,
      agent_id: "agent_other",
      order_id: "order_fixture",
      entitlement_id: "entitlement_fixture",
      task_id: "task_fixture"
    }),
    (error) => error.code === "identity_chain_mismatch"
  );
});
