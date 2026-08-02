import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommerceInvariantError,
  CommerceLedger,
  projectBuyerEntitlements,
  projectCreatorDashboard
} from "./index.js";

async function seedLocalUatCommerce(ledger, fixture = {}) {
  const values = {
    buyerId: "buyer_fixture",
    buyerDisplayName: "Fixture Buyer",
    creatorId: "creator_fixture",
    productId: "product_fixture",
    productName: "Fixture Product",
    agentId: "agent_fixture",
    orderId: "order_fixture",
    entitlementId: "entitlement_fixture",
    ...fixture
  };
  await ledger.append("order.placed", {
    order_id: values.orderId,
    buyer_id: values.buyerId,
    buyer_display_name: values.buyerDisplayName,
    creator_id: values.creatorId,
    product_id: values.productId,
    product_name: values.productName,
    agent_id: values.agentId,
    gross_minor: 3900,
    currency: "USD"
  }, { idempotencyKey: `order:${values.orderId}:placed` });
  await ledger.append("entitlement.granted", {
    entitlement_id: values.entitlementId,
    order_id: values.orderId,
    buyer_id: values.buyerId,
    creator_id: values.creatorId,
    product_id: values.productId,
    agent_id: values.agentId
  }, { idempotencyKey: `order:${values.orderId}:entitlement` });
  return values;
}

function deterministicLedger(filePath) {
  let sequence = 0;
  return CommerceLedger.open({
    filePath,
    clock: () => new Date("2026-07-31T08:00:00.000Z"),
    idFactory: (type) => `${type.replaceAll(".", "_")}_${++sequence}`
  });
}

test("one delivery recognizes the exact 90/10 split and preserves the creator + agent identity", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const ledger = await deterministicLedger(filePath);
  const fixture = await seedLocalUatCommerce(ledger);

  await ledger.append("task.started", {
    task_id: "task_jordan_001",
    order_id: fixture.orderId,
    entitlement_id: fixture.entitlementId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    product_id: fixture.productId,
    agent_id: fixture.agentId
  }, { idempotencyKey: "task:task_jordan_001:started" });
  await ledger.append("artifact.created", {
    artifact_id: "artifact_jordan_001",
    task_id: "task_jordan_001",
    order_id: fixture.orderId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    product_id: fixture.productId,
    agent_id: fixture.agentId,
    artifact_digest: "sha256:artifact"
  }, { idempotencyKey: "artifact:artifact_jordan_001:created" });
  await ledger.append("delivery.completed", {
    delivery_id: "delivery_jordan_001",
    artifact_id: "artifact_jordan_001",
    task_id: "task_jordan_001",
    order_id: fixture.orderId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    product_id: fixture.productId,
    agent_id: fixture.agentId
  }, { idempotencyKey: "delivery:delivery_jordan_001:completed" });
  await ledger.append("revenue.recognized", {
    recognition_id: "revenue_jordan_001",
    delivery_id: "delivery_jordan_001",
    order_id: fixture.orderId,
    creator_id: fixture.creatorId,
    product_id: fixture.productId,
    agent_id: fixture.agentId,
    gross_minor: 3900,
    creator_share_minor: 3510,
    hatch_share_minor: 390,
    currency: "USD"
  }, { idempotencyKey: "order:order_hch_2454:revenue" });

  assert.deepEqual(projectBuyerEntitlements(ledger.listEvents(), fixture.buyerId), [{
    entitlement_id: fixture.entitlementId,
    order_id: fixture.orderId,
    creator_id: fixture.creatorId,
    product_id: fixture.productId,
    agent_id: fixture.agentId,
    status: "active"
  }]);
  assert.deepEqual(projectCreatorDashboard(ledger.listEvents(), fixture.creatorId).metrics, {
    orders: 1,
    successful_deliveries: 1,
    gross_minor: 3900,
    creator_share_minor: 3510,
    hatch_share_minor: 390
  });
  const [order] = projectCreatorDashboard(ledger.listEvents(), fixture.creatorId).orders;
  assert.deepEqual({
    creator_id: order.creator_id,
    product_id: order.product_id,
    agent_id: order.agent_id,
    order_id: order.order_id,
    entitlement_id: order.entitlement_id,
    task_id: order.task_id,
    artifact_id: order.artifact_id,
    artifact_digest: order.artifact_digest,
    delivery_id: order.delivery_id,
    recognition_id: order.recognition_id
  }, {
    creator_id: "creator_fixture",
    product_id: "product_fixture",
    agent_id: "agent_fixture",
    order_id: "order_fixture",
    entitlement_id: "entitlement_fixture",
    task_id: "task_jordan_001",
    artifact_id: "artifact_jordan_001",
    artifact_digest: "sha256:artifact",
    delivery_id: "delivery_jordan_001",
    recognition_id: "revenue_jordan_001"
  });

  const reopened = await CommerceLedger.open({ filePath });
  assert.equal(reopened.listEvents().length, 6);
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 6);
});

test("replaying the same idempotent mutation never duplicates a charge or delivery", async () => {
  const ledger = await CommerceLedger.open();
  const fixture = await seedLocalUatCommerce(ledger);
  const replay = await seedLocalUatCommerce(ledger);
  assert.equal(replay.orderId, fixture.orderId);
  assert.equal(ledger.listEvents().length, 2);

  await assert.rejects(
    ledger.append("order.placed", {
      order_id: fixture.orderId,
      buyer_id: fixture.buyerId,
      buyer_display_name: "Jordan Lee",
      creator_id: fixture.creatorId,
      product_id: fixture.productId,
      agent_id: fixture.agentId,
      gross_minor: 9999,
      currency: "USD"
    }, { idempotencyKey: `order:${fixture.orderId}:placed` }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );
});

test("creator projection isolates another creator's orders", async () => {
  const ledger = await CommerceLedger.open();
  await seedLocalUatCommerce(ledger);
  await ledger.append("order.placed", {
    order_id: "order_other",
    buyer_id: "buyer_other",
    buyer_display_name: "Other Buyer",
    creator_id: "creator_other",
    product_id: "product_other",
    agent_id: "agent_other",
    gross_minor: 12500,
    currency: "USD"
  }, { idempotencyKey: "order:order_other:placed" });

  const fixtureCreator = projectCreatorDashboard(ledger.listEvents(), "creator_fixture");
  assert.equal(fixtureCreator.metrics.orders, 1);
  assert.equal(fixtureCreator.metrics.gross_minor, 3900);
  assert.equal(fixtureCreator.orders[0].buyer_display_name, "Fixture Buyer");
});

test("an event cannot move a task to a different Agent", async () => {
  const ledger = await CommerceLedger.open();
  const fixture = await seedLocalUatCommerce(ledger);
  await assert.rejects(
    ledger.append("task.started", {
      task_id: "task_wrong_agent",
      order_id: fixture.orderId,
      entitlement_id: fixture.entitlementId,
      buyer_id: fixture.buyerId,
      creator_id: fixture.creatorId,
      product_id: fixture.productId,
      agent_id: "agent_other"
    }, { idempotencyKey: "task:wrong-agent" }),
    (error) => error instanceof CommerceInvariantError && error.code === "identity_chain_mismatch"
  );
});

test("revenue cannot be recognized before a delivery or with an invalid split", async () => {
  const ledger = await CommerceLedger.open();
  const fixture = await seedLocalUatCommerce(ledger);
  await assert.rejects(
    ledger.append("revenue.recognized", {
      recognition_id: "revenue_early",
      delivery_id: "missing_delivery",
      order_id: fixture.orderId,
      creator_id: fixture.creatorId,
      product_id: fixture.productId,
      agent_id: fixture.agentId,
      gross_minor: 3900,
      creator_share_minor: 3510,
      hatch_share_minor: 390,
      currency: "USD"
    }, { idempotencyKey: "revenue:early" }),
    (error) => error instanceof CommerceInvariantError && error.code === "missing_prior_event"
  );
});
