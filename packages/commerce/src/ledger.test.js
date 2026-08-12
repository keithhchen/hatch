import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CommerceInvariantError,
  CommerceLedger,
  CommercePersistenceError,
  projectBuyerEntitlements,
  projectBuyerOrders,
  projectCreatorDashboard,
  projectEntitlement,
  projectOrder,
  projectRefunds
} from "./index.js";

async function seedLocalUatCommerce(ledger, fixture = {}) {
  const values = {
    buyerId: "buyer_fixture",
    buyerDisplayName: "Fixture Buyer",
    creatorId: "creator_fixture",
    agentId: "agent_fixture",
    productId: "product_fixture",
    productName: "Fixture Product",
    corpusDigest: `sha256:${"a".repeat(64)}`,
    orderId: "order_fixture",
    entitlementId: "entitlement_fixture",
    ...fixture
  };
  await ledger.append("order.placed", {
    order_id: values.orderId,
    buyer_id: values.buyerId,
    buyer_display_name: values.buyerDisplayName,
    creator_id: values.creatorId,
    agent_id: values.agentId,
    product_id: values.productId,
    product_name: values.productName,
    corpus_digest: values.corpusDigest,
    gross_minor: 3900,
    currency: "USD"
  }, { idempotencyKey: `order:${values.orderId}:placed` });
  await ledger.append("entitlement.granted", {
    entitlement_id: values.entitlementId,
    order_id: values.orderId,
    buyer_id: values.buyerId,
    creator_id: values.creatorId,
    agent_id: values.agentId,
    product_id: values.productId,
    corpus_digest: values.corpusDigest
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

test("every persisted Commerce event carries the canonical audit envelope", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-audit-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const ledger = await deterministicLedger(filePath);
  const fixture = await seedLocalUatCommerce(ledger);
  await ledger.append("task.started", {
    task_id: "task_audit",
    order_id: fixture.orderId,
    entitlement_id: fixture.entitlementId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest
  }, { idempotencyKey: "task:audit:started" });

  const reopened = await CommerceLedger.open({ filePath });
  const events = reopened.listEvents();
  assert.equal(events.length, 3);
  for (const event of events) {
    assert.equal(event.schema_version, 1);
    for (const field of [
      "aggregate_type", "aggregate_id", "tenant_id", "actor_type", "actor_id",
      "service_id", "request_id", "correlation_id", "causation_id", "reason"
    ]) {
      assert.ok(Object.hasOwn(event, field), `${event.event_type} missing ${field}`);
    }
    assert.equal(typeof event.aggregate_type, "string");
    assert.equal(typeof event.aggregate_id, "string");
    assert.equal(typeof event.actor_id, "string");
    assert.equal(typeof event.request_id, "string");
  }
  assert.equal(events[0].aggregate_type, "order");
  assert.equal(events[0].aggregate_id, fixture.orderId);
  assert.equal(events[0].actor_id, fixture.buyerId);
  assert.equal(events[0].request_id, `order:${fixture.orderId}:placed`);
  assert.equal(events[2].actor_type, "service");
  assert.equal(events[2].actor_id, "runtime");
});

test("one delivery recognizes the exact 90/10 split and projects the same creator dashboard", async () => {
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
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest
  }, { idempotencyKey: "task:task_jordan_001:started" });
  await ledger.append("artifact.created", {
    artifact_id: "artifact_jordan_001",
    task_id: "task_jordan_001",
    order_id: fixture.orderId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest,
    artifact_digest: "sha256:artifact"
  }, { idempotencyKey: "artifact:artifact_jordan_001:created" });
  await ledger.append("delivery.completed", {
    delivery_id: "delivery_jordan_001",
    artifact_id: "artifact_jordan_001",
    task_id: "task_jordan_001",
    order_id: fixture.orderId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest
  }, { idempotencyKey: "delivery:delivery_jordan_001:completed" });
  await ledger.append("revenue.recognized", {
    recognition_id: "revenue_jordan_001",
    delivery_id: "delivery_jordan_001",
    order_id: fixture.orderId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest,
    gross_minor: 3900,
    creator_share_minor: 3510,
    hatch_share_minor: 390,
    currency: "USD"
  }, { idempotencyKey: "order:order_hch_2454:revenue" });

  assert.deepEqual(projectBuyerEntitlements(ledger.listEvents(), fixture.buyerId), [{
    entitlement_id: fixture.entitlementId,
    order_id: fixture.orderId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest,
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
    creator_id: fixture.creatorId,
    agent_id: order.agent_id,
    product_id: order.product_id,
    corpus_digest: order.corpus_digest,
    order_id: order.order_id,
    entitlement_id: order.entitlement_id,
    task_id: order.task_id,
    artifact_id: order.artifact_id,
    artifact_digest: order.artifact_digest,
    delivery_id: order.delivery_id,
    recognition_id: order.recognition_id
  }, {
    creator_id: "creator_fixture",
    agent_id: "agent_fixture",
    product_id: "product_fixture",
    corpus_digest: `sha256:${"a".repeat(64)}`,
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
      agent_id: fixture.agentId,
      product_id: fixture.productId,
      corpus_digest: fixture.corpusDigest,
      gross_minor: 9999,
      currency: "USD"
    }, { idempotencyKey: `order:${fixture.orderId}:placed` }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );
});

test("already-open Dashboard and Runtime ledgers refresh each other's committed events", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-shared-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const runtimeLedger = await deterministicLedger(filePath);
  const dashboardLedger = await deterministicLedger(filePath);
  const fixture = await seedLocalUatCommerce(dashboardLedger, {
    orderId: "order_shared",
    entitlementId: "entitlement_shared"
  });

  assert.equal(runtimeLedger.findByIdempotencyKey("order:order_shared:placed")?.order_id, fixture.orderId);
  await runtimeLedger.append("task.started", {
    task_id: "task_shared",
    order_id: fixture.orderId,
    entitlement_id: fixture.entitlementId,
    buyer_id: fixture.buyerId,
    creator_id: fixture.creatorId,
    agent_id: fixture.agentId,
    product_id: fixture.productId,
    corpus_digest: fixture.corpusDigest
  }, { idempotencyKey: "task:task_shared:started" });

  assert.deepEqual(dashboardLedger.listEvents().map((event) => event.event_type), [
    "order.placed",
    "entitlement.granted",
    "task.started"
  ]);
});

test("separate processes serialize one idempotent mutation and converge on the winner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-processes-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const startFile = path.join(directory, "start");
  const readerOpenedBeforeWriters = await CommerceLedger.open({ filePath });
  const first = startAppendWorker(filePath, startFile, "order:concurrent", "order_concurrent");
  const second = startAppendWorker(filePath, startFile, "order:concurrent", "order_concurrent");

  await Promise.all([first.ready, second.ready]);
  await writeFile(startFile, "go", "utf8");
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal(firstResult.event.event_id, secondResult.event.event_id);
  assert.equal(readerOpenedBeforeWriters.listEvents().length, 1);
  assert.equal(readerOpenedBeforeWriters.findByIdempotencyKey("order:concurrent")?.order_id, "order_concurrent");
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 1);
});

test("separate processes preserve distinct concurrent mutations without a lost update", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-distinct-processes-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const startFile = path.join(directory, "start");
  const readerOpenedBeforeWriters = await CommerceLedger.open({ filePath });
  const first = startAppendWorker(filePath, startFile, "order:concurrent:first", "order_concurrent_first");
  const second = startAppendWorker(filePath, startFile, "order:concurrent:second", "order_concurrent_second");

  await Promise.all([first.ready, second.ready]);
  await writeFile(startFile, "go", "utf8");
  const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.notEqual(firstResult.event.event_id, secondResult.event.event_id);
  assert.deepEqual(
    new Set(readerOpenedBeforeWriters.listEvents().map((event) => event.order_id)),
    new Set(["order_concurrent_first", "order_concurrent_second"])
  );
  assert.equal((await readFile(filePath, "utf8")).trim().split("\n").length, 2);
});

test("an abandoned cross-process lock fails closed instead of being guessed stale", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-lock-"));
  const filePath = path.join(directory, "ledger.jsonl");
  await mkdir(`${filePath}.lock`);
  const ledger = await CommerceLedger.open({ filePath, lockTimeoutMs: 40, lockPollMs: 5 });

  await assert.rejects(
    ledger.append("order.placed", {
      order_id: "order_locked",
      buyer_id: "buyer_locked",
      creator_id: "creator_locked",
      agent_id: "agent_locked",
      product_id: "product_locked",
      corpus_digest: `sha256:${"e".repeat(64)}`,
      gross_minor: 100,
      currency: "USD"
    }, { idempotencyKey: "order:locked" }),
    (error) => error instanceof CommercePersistenceError
      && error.code === "ledger_lock_timeout"
      && error.message.includes(`${filePath}.lock`)
  );
  assert.equal((await stat(`${filePath}.lock`)).isDirectory(), true);
});

test("creator projection isolates another creator's orders", async () => {
  const ledger = await CommerceLedger.open();
  await seedLocalUatCommerce(ledger);
  await ledger.append("order.placed", {
    order_id: "order_other",
    buyer_id: "buyer_other",
    buyer_display_name: "Other Buyer",
    creator_id: "creator_other",
    agent_id: "agent_other",
    product_id: "product_other",
    corpus_digest: `sha256:${"c".repeat(64)}`,
    gross_minor: 12500,
    currency: "USD"
  }, { idempotencyKey: "order:order_other:placed" });

  const fixtureCreator = projectCreatorDashboard(ledger.listEvents(), "creator_fixture");
  assert.equal(fixtureCreator.metrics.orders, 1);
  assert.equal(fixtureCreator.metrics.gross_minor, 3900);
  assert.equal(fixtureCreator.orders[0].buyer_display_name, "Fixture Buyer");
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
      agent_id: fixture.agentId,
      product_id: fixture.productId,
      corpus_digest: fixture.corpusDigest,
      gross_minor: 3900,
      creator_share_minor: 3510,
      hatch_share_minor: 390,
      currency: "USD"
    }, { idempotencyKey: "revenue:early" }),
    (error) => error instanceof CommerceInvariantError && error.code === "missing_prior_event"
  );
});

test("zero-value checkout is still a real order and can project buyer history", async () => {
  const ledger = await CommerceLedger.open();
  await ledger.append("order.placed", {
    order_id: "order_zero",
    buyer_id: "buyer_zero",
    buyer_display_name: "Zero Buyer",
    creator_id: "creator_zero",
    agent_id: "agent_zero",
    product_id: "product_zero",
    product_name: "Zero Product",
    corpus_digest: `sha256:${"b".repeat(64)}`,
    gross_minor: 0,
    currency: "USD",
    payment_status: "paid",
    payment_id: "pay_zero"
  }, { idempotencyKey: "order:order_zero" });

  assert.deepEqual(projectBuyerOrders(ledger.listEvents(), "buyer_zero"), [{
    order_id: "order_zero",
    creator_id: "creator_zero",
    agent_id: "agent_zero",
    product_id: "product_zero",
    corpus_digest: `sha256:${"b".repeat(64)}`,
    product_name: "Zero Product",
    gross_minor: 0,
    subtotal_minor: 0,
    discount_minor: 0,
    tax_minor: null,
    total_minor: 0,
    currency: "USD",
    status: "paid",
    payment_status: "not_required",
    payment_id: null,
    occurred_at: ledger.listEvents()[0].occurred_at,
    entitlement_id: null
  }]);
});

function startAppendWorker(filePath, startFile, idempotencyKey, orderId) {
  const fixture = fileURLToPath(new URL("../test-fixtures/append-order.mjs", import.meta.url));
  const child = spawn(process.execPath, [fixture, filePath, startFile, idempotencyKey, orderId], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.includes("READY\n")) readyResolve();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", readyReject);
  const completed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`ledger worker exited ${code}: ${stderr || stdout}`);
        readyReject(error);
        reject(error);
        return;
      }
      const resultLine = stdout.trim().split("\n").findLast((line) => line.startsWith("{"));
      if (!resultLine) {
        reject(new Error(`ledger worker returned no result: ${stderr || stdout}`));
        return;
      }
      resolve(JSON.parse(resultLine));
    });
  });
  return { ready, completed };
}
