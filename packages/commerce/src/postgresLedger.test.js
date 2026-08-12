import assert from "node:assert/strict";
import test from "node:test";
import { CommerceInvariantError, CommerceService, PostgresCommerceLedger } from "./index.js";

const FIXED_TIME = "2026-08-12T08:00:00.000Z";

test("Postgres ledger hydrates and atomically writes events with their outbox records", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  const staleLedger = await PostgresCommerceLedger.open({ pool });

  const result = await ledger.appendMany(checkoutMutations());
  assert.equal(result.length, 2);
  assert.equal(ledger.listEvents().length, 2);
  assert.equal(pool.database.events.length, 2);
  assert.equal(pool.database.outbox.length, 2);
  assert.equal(pool.database.readModels.some((model) => model.model_type === "order"), true);
  assert.equal(pool.database.readModels.some((model) => model.model_type === "entitlement"), true);
  assert.equal(ledger.readModelSequence, 2);
  assert.equal(ledger.readOrder("order_fixture").status, "fulfilled");
  assert.equal(ledger.readEntitlement("entitlement_fixture").remaining_units, 1);
  assert.equal(ledger.findByIdempotencyKey("checkout:fixture:order").order_id, "order_fixture");

  const staleReplay = await staleLedger.appendMany(checkoutMutations());
  assert.deepEqual(staleReplay, result);
  assert.equal(staleLedger.listEvents().length, 2);
  assert.equal(pool.database.events.length, 2);

  const reopened = await PostgresCommerceLedger.open({ pool });
  assert.deepEqual(reopened.listEvents(), ledger.listEvents());
  assert.equal(pool.createdTables.has("commerce_events"), true);
  assert.equal(pool.createdTables.has("commerce_outbox"), true);
  assert.equal(pool.createdTables.has("commerce_inbox"), true);
  assert.equal(pool.createdTables.has("commerce_read_models"), true);
  assert.equal(pool.createdTables.has("commerce_read_model_state"), true);
});

test("CommerceService query APIs use Postgres read models without replaying the audit stream", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  await ledger.appendMany(checkoutMutations());
  const commerce = new CommerceService(ledger, { clock: () => new Date(FIXED_TIME) });
  await commerce.updatePayoutAccount({
    creator_id: "creator_fixture",
    currency: "USD",
    provider: "stripe",
    provider_account_id: "acct_fixture",
    status: "active",
    idempotency_key: "payout-account:fixture"
  });

  ledger.listEvents = () => {
    throw new Error("audit stream query should not run");
  };

  assert.equal(commerce.getOrder("order_fixture").entitlement.entitlement_id, "entitlement_fixture");
  assert.equal(commerce.listBuyerOrders("buyer_fixture")[0].order_id, "order_fixture");
  assert.equal(commerce.listBuyerEntitlements("buyer_fixture")[0].remaining_units, 1);
  assert.equal(commerce.listCreatorOrders("creator_fixture")[0].order_id, "order_fixture");
  assert.equal(commerce.getCreatorDashboard("creator_fixture").metrics.orders, 1);
  assert.deepEqual(commerce.listPayoutAccounts(), [{
    creator_id: "creator_fixture",
    currency: "USD",
    status: "active",
    provider: "stripe",
    provider_account_id: "acct_fixture",
    requirements: [],
    updated_at: FIXED_TIME
  }]);
  assert.deepEqual(commerce.listDeliveries(), []);
  assert.deepEqual(commerce.listRefunds(), []);
});

test("read-model persistence failure rolls back aggregate events and outbox together", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  pool.failNextReadModelInsert = true;

  await assert.rejects(ledger.appendMany(checkoutMutations()), /simulated read model failure/);
  assert.equal(pool.database.events.length, 0);
  assert.equal(pool.database.outbox.length, 0);
  assert.equal(pool.database.readModels.length, 0);
  assert.equal(pool.database.readModelState[0].last_event_sequence, 0);
  assert.equal(ledger.listEvents().length, 0);
});

test("open backfills missing Postgres read models from retained audit events", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  await ledger.appendMany(checkoutMutations());
  const expected = ledger.readOrder("order_fixture");

  pool.database.readModels = [];
  pool.database.readModelState = [];
  const reopened = await deterministicLedger(pool);

  assert.deepEqual(reopened.readOrder("order_fixture"), expected);
  assert.equal(reopened.readModelSequence, 2);
  assert.equal(pool.database.readModels.length > 0, true);
  assert.equal(pool.database.readModelState[0].model_count, pool.database.readModels.length);
});

test("Postgres idempotency replays the same payload and rejects a changed payload", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  const first = await ledger.appendMany(checkoutMutations());
  const replay = await ledger.appendMany(checkoutMutations());

  assert.deepEqual(replay, first);
  assert.equal(pool.database.events.length, 2);
  assert.equal(pool.database.outbox.length, 2);

  const conflict = checkoutMutations();
  conflict[0].payload.gross_minor = 4900;
  await assert.rejects(
    ledger.appendMany(conflict),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );
  assert.equal(pool.database.events.length, 2);
  assert.equal(pool.database.outbox.length, 2);
});

test("an outbox failure rolls back every event in appendMany", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  pool.failNextOutboxInsert = true;

  await assert.rejects(ledger.appendMany(checkoutMutations()), /simulated outbox failure/);
  assert.equal(pool.database.events.length, 0);
  assert.equal(pool.database.outbox.length, 0);
  assert.equal(ledger.listEvents().length, 0);
});

test("outbox dispatch marks successes and leaves failures retryable", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  await ledger.appendMany(checkoutMutations());
  const seen = [];

  const first = await ledger.dispatchOutbox(async (event) => {
    seen.push(event.event_type);
    if (event.event_type === "entitlement.granted") throw new Error("consumer offline");
  });
  assert.deepEqual(first, {
    claimed: 2,
    dispatched: 1,
    failed: 1,
    errors: [{
      outbox_id: "2",
      event_id: "entitlement_granted_2",
      message: "consumer offline"
    }]
  });
  assert.deepEqual(seen, ["order.placed", "entitlement.granted"]);
  assert.equal((await ledger.listPendingOutbox()).length, 1);

  const second = await ledger.dispatchOutbox(async () => {});
  assert.deepEqual(second, { claimed: 1, dispatched: 1, failed: 0, errors: [] });
  assert.equal((await ledger.listPendingOutbox()).length, 0);
  assert.equal(pool.database.outbox[1].attempts, 2);
});

test("inbox records are exactly-once per consumer and payload", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  const payload = { provider_event_id: "evt_123", status: "paid" };

  const first = await ledger.markInbox("stripe-webhook", "evt_123", payload, {
    result: { order_id: "order_fixture" }
  });
  const replay = await ledger.markInbox("stripe-webhook", "evt_123", {
    status: "paid",
    provider_event_id: "evt_123"
  });
  assert.equal(first.inserted, true);
  assert.equal(replay.inserted, false);
  assert.equal(replay.replay, true);
  assert.deepEqual((await ledger.findInbox("stripe-webhook", "evt_123")).result, {
    order_id: "order_fixture"
  });

  await assert.rejects(
    ledger.markInbox("stripe-webhook", "evt_123", { ...payload, status: "failed" }),
    (error) => error instanceof CommerceInvariantError && error.code === "inbox_idempotency_conflict"
  );
  assert.equal(pool.database.inbox.length, 1);
});

test("provider inbox, aggregate events and outbox commit atomically", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  const payload = { provider_event_id: "evt_atomic", status: "succeeded" };
  const first = await ledger.appendManyFromInbox(
    "provider-webhook",
    "evt_atomic",
    payload,
    checkoutMutations()
  );
  assert.equal(first.inserted, true);
  assert.equal(first.events.length, 2);
  assert.equal(pool.database.inbox.length, 1);
  assert.equal(pool.database.events.length, 2);
  assert.equal(pool.database.outbox.length, 2);

  const replay = await ledger.appendManyFromInbox(
    "provider-webhook",
    "evt_atomic",
    { status: "succeeded", provider_event_id: "evt_atomic" },
    checkoutMutations()
  );
  assert.equal(replay.replay, true);
  assert.equal(pool.database.events.length, 2);
  await assert.rejects(
    ledger.appendManyFromInbox(
      "provider-webhook",
      "evt_atomic",
      { provider_event_id: "evt_atomic", status: "failed" },
      checkoutMutations()
    ),
    (error) => error instanceof CommerceInvariantError && error.code === "inbox_idempotency_conflict"
  );

  const failingPool = new FakePool();
  const failingLedger = await deterministicLedger(failingPool);
  failingPool.failNextOutboxInsert = true;
  await assert.rejects(
    failingLedger.appendManyFromInbox("provider-webhook", "evt_rollback", payload, checkoutMutations()),
    /simulated outbox failure/
  );
  assert.equal(failingPool.database.inbox.length, 0);
  assert.equal(failingPool.database.events.length, 0);
  assert.equal(failingPool.database.outbox.length, 0);
});

test("CommerceService payment webhook atomically commits inbox, payment, order, entitlement, outbox, and read models", async () => {
  const pool = new FakePool();
  const ledger = await deterministicLedger(pool);
  const commerce = new CommerceService(ledger);
  await commerce.createPayment({
    payment_id: "payment_postgres_provider",
    buyer_id: "buyer_postgres_provider",
    creator_id: "creator_postgres_provider",
    product_id: "product_postgres_provider",
    amount_minor: 2500,
    currency: "USD",
    provider: "stripe",
    idempotency_key: "payment:postgres:create"
  });
  const providerEvent = {
    payment_id: "payment_postgres_provider",
    provider: "stripe",
    provider_event_id: "evt_postgres_succeeded",
    provider_sequence: 1,
    status: "succeeded"
  };
  const checkout = {
    buyer_id: "buyer_postgres_provider",
    creator_id: "creator_postgres_provider",
    agent_id: "agent_postgres_provider",
    product_id: "product_postgres_provider",
    corpus_digest: `sha256:${"c".repeat(64)}`,
    payment_id: "payment_postgres_provider",
    gross_minor: 2500,
    currency: "USD",
    idempotency_key: "checkout:postgres:provider"
  };
  const first = await commerce.confirmCheckoutFromProviderEvent(providerEvent, checkout);
  const replay = await commerce.confirmCheckoutFromProviderEvent(providerEvent, checkout);
  assert.equal(first.payment.status, "succeeded");
  assert.equal(first.order.order_id, replay.order.order_id);
  assert.equal(first.entitlement.entitlement_id, replay.entitlement.entitlement_id);
  assert.equal(replay.payment.provider_events.length, 1);
  assert.equal(pool.database.inbox.length, 1);
  assert.equal(pool.database.events.length, 4);
  assert.equal(pool.database.outbox.length, 4);
  ledger.listEvents = () => {
    throw new Error("checkout queries should use persisted read models");
  };
  assert.equal(commerce.getPayment("payment_postgres_provider").status, "succeeded");
  assert.equal(commerce.listPayments({ buyerId: "buyer_postgres_provider" }).length, 1);
  assert.equal(commerce.getOrder(first.order.order_id).payment_status, "succeeded");
  assert.equal(commerce.getEntitlement(first.entitlement.entitlement_id).status, "active");
});

test("a supplied Pool constructor is owned and closed by the ledger", async () => {
  let constructedWith;
  let instance;
  class Pool extends FakePool {
    constructor(options) {
      super();
      instance = this;
      constructedWith = options;
    }
  }
  const ledger = await PostgresCommerceLedger.open({
    Pool,
    connectionString: "postgres://commerce.example/hatch"
  });
  await ledger.close();
  await ledger.close();
  assert.deepEqual(constructedWith, { connectionString: "postgres://commerce.example/hatch" });
  assert.equal(instance.endCalls, 1);
});

function deterministicLedger(pool) {
  let sequence = 0;
  return PostgresCommerceLedger.open({
    pool,
    clock: () => new Date(FIXED_TIME),
    idFactory: (type) => `${type.replaceAll(".", "_")}_${++sequence}`
  });
}

function checkoutMutations() {
  const identity = {
    buyer_id: "buyer_fixture",
    creator_id: "creator_fixture",
    agent_id: "agent_fixture",
    product_id: "product_fixture",
    corpus_digest: `sha256:${"a".repeat(64)}`
  };
  return [
    {
      type: "order.placed",
      payload: {
        ...identity,
        order_id: "order_fixture",
        gross_minor: 3900,
        currency: "USD"
      },
      idempotencyKey: "checkout:fixture:order"
    },
    {
      type: "entitlement.granted",
      payload: {
        ...identity,
        entitlement_id: "entitlement_fixture",
        order_id: "order_fixture"
      },
      idempotencyKey: "checkout:fixture:entitlement"
    }
  ];
}

class FakePool {
  constructor() {
    this.database = emptyDatabase();
    this.createdTables = new Set();
    this.failNextOutboxInsert = false;
    this.failNextReadModelInsert = false;
    this.endCalls = 0;
  }

  async query(sql, parameters = []) {
    return runQuery(this, this.database, sql, parameters);
  }

  async connect() {
    return new FakeClient(this);
  }

  async end() {
    this.endCalls += 1;
  }
}

class FakeClient {
  constructor(pool) {
    this.pool = pool;
    this.transaction = null;
  }

  async query(sql, parameters = []) {
    const command = normalizeSql(sql);
    if (command === "BEGIN") {
      this.transaction = structuredClone(this.pool.database);
      return result();
    }
    if (command === "COMMIT") {
      this.pool.database = this.transaction;
      this.transaction = null;
      return result();
    }
    if (command === "ROLLBACK") {
      this.transaction = null;
      return result();
    }
    return runQuery(this.pool, this.transaction ?? this.pool.database, sql, parameters);
  }

  release() {}
}

function runQuery(pool, database, sql, parameters) {
  const command = normalizeSql(sql);
  if (command.startsWith("CREATE TABLE IF NOT EXISTS")) {
    const match = command.match(/^CREATE TABLE IF NOT EXISTS ([A-Z_]+)/);
    if (match) pool.createdTables.add(match[1].toLowerCase());
    return result();
  }
  if (command.startsWith("CREATE INDEX IF NOT EXISTS") || command.startsWith("SELECT PG_ADVISORY_XACT_LOCK")) {
    return result();
  }
  if (command.includes("FROM COMMERCE_EVENTS") && command.includes("ORDER BY SEQUENCE")) {
    return result(database.events.map((event) => ({ ...event })));
  }
  if (command.startsWith("SELECT COALESCE(MAX(SEQUENCE), 0) AS LAST_EVENT_SEQUENCE FROM COMMERCE_EVENTS")) {
    const lastEventSequence = database.events.reduce(
      (maximum, event) => Math.max(maximum, Number(event.sequence)),
      0
    );
    return result([{ last_event_sequence: lastEventSequence }]);
  }
  if (command.startsWith("INSERT INTO COMMERCE_EVENTS")) {
    const [eventId, eventType, occurredAt, idempotencyKey, payloadDigest, payload] = parameters;
    if (database.events.some((event) => event.event_id === eventId || event.idempotency_key === idempotencyKey)) {
      const error = new Error("duplicate commerce event");
      error.code = "23505";
      throw error;
    }
    database.events.push({
      sequence: database.nextEventSequence++,
      event_id: eventId,
      event_type: eventType,
      occurred_at: occurredAt,
      idempotency_key: idempotencyKey,
      payload_digest: payloadDigest,
      payload: parseJson(payload)
    });
    return result([], 1);
  }
  if (command.startsWith("INSERT INTO COMMERCE_OUTBOX")) {
    if (pool.failNextOutboxInsert) {
      pool.failNextOutboxInsert = false;
      throw new Error("simulated outbox failure");
    }
    const [eventId, topic, payload] = parameters;
    database.outbox.push({
      outbox_id: database.nextOutboxSequence++,
      event_id: eventId,
      topic,
      payload: parseJson(payload),
      attempts: 0,
      created_at: FIXED_TIME,
      locked_at: null,
      lock_token: null,
      dispatched_at: null,
      last_error: null
    });
    return result([], 1);
  }
  if (command.startsWith("WITH PENDING AS") && command.includes("UPDATE COMMERCE_OUTBOX AS ITEM")) {
    const [limit, , lockToken] = parameters;
    const pending = database.outbox.filter((item) => !item.dispatched_at && !item.locked_at).slice(0, limit);
    for (const item of pending) {
      item.locked_at = FIXED_TIME;
      item.lock_token = lockToken;
      item.attempts += 1;
    }
    return result(pending.map((item) => ({ ...item })));
  }
  if (command.startsWith("UPDATE COMMERCE_OUTBOX") && command.includes("SET DISPATCHED_AT = NOW()")) {
    const [outboxId, lockToken] = parameters;
    const item = database.outbox.find((candidate) => String(candidate.outbox_id) === String(outboxId));
    if (item?.lock_token === lockToken && !item.dispatched_at) {
      item.dispatched_at = FIXED_TIME;
      item.locked_at = null;
      item.lock_token = null;
      item.last_error = null;
      return result([], 1);
    }
    return result();
  }
  if (command.startsWith("UPDATE COMMERCE_OUTBOX") && command.includes("SET LOCKED_AT = NULL")) {
    const [outboxId, lockToken, message] = parameters;
    const item = database.outbox.find((candidate) => String(candidate.outbox_id) === String(outboxId));
    if (item?.lock_token === lockToken && !item.dispatched_at) {
      item.locked_at = null;
      item.lock_token = null;
      item.last_error = message;
      return result([], 1);
    }
    return result();
  }
  if (command.includes("FROM COMMERCE_OUTBOX") && command.includes("WHERE DISPATCHED_AT IS NULL")) {
    const [limit] = parameters;
    return result(database.outbox.filter((item) => !item.dispatched_at).slice(0, limit).map((item) => ({ ...item })));
  }
  if (command.startsWith("INSERT INTO COMMERCE_INBOX")) {
    const [consumerName, idempotencyKey, payloadDigest, payload, storedResult] = parameters;
    const existing = database.inbox.find((item) => (
      item.consumer_name === consumerName && item.idempotency_key === idempotencyKey
    ));
    if (existing) return result();
    const record = {
      consumer_name: consumerName,
      idempotency_key: idempotencyKey,
      payload_digest: payloadDigest,
      payload: parseJson(payload),
      result: parseJson(storedResult),
      processed_at: FIXED_TIME
    };
    database.inbox.push(record);
    return result([{ ...record }], 1);
  }
  if (command.includes("FROM COMMERCE_INBOX") && command.includes("WHERE CONSUMER_NAME = $1")) {
    const [consumerName, idempotencyKey] = parameters;
    const record = database.inbox.find((item) => (
      item.consumer_name === consumerName && item.idempotency_key === idempotencyKey
    ));
    return result(record ? [{ ...record }] : []);
  }
  if (command.includes("FROM COMMERCE_READ_MODEL_STATE") && command.includes("WHERE PROJECTION_NAME = $1")) {
    const [projectionName] = parameters;
    const state = database.readModelState.find((item) => item.projection_name === projectionName);
    return result(state ? [{ ...state }] : []);
  }
  if (command.includes("FROM COMMERCE_READ_MODELS") && command.includes("ORDER BY MODEL_TYPE, MODEL_ID")) {
    return result(database.readModels
      .map((model) => ({ ...model }))
      .sort((left, right) => (
        left.model_type.localeCompare(right.model_type) || left.model_id.localeCompare(right.model_id)
      )));
  }
  if (command === "DELETE FROM COMMERCE_READ_MODELS") {
    database.readModels = [];
    return result();
  }
  if (command.startsWith("INSERT INTO COMMERCE_READ_MODELS")) {
    if (pool.failNextReadModelInsert) {
      pool.failNextReadModelInsert = false;
      throw new Error("simulated read model failure");
    }
    const [
      modelType,
      modelId,
      buyerId,
      creatorId,
      productId,
      orderId,
      entitlementId,
      status,
      currency,
      occurredAt,
      modelUpdatedAt,
      lastEventSequence,
      snapshot
    ] = parameters;
    database.readModels.push({
      model_type: modelType,
      model_id: modelId,
      buyer_id: buyerId,
      creator_id: creatorId,
      product_id: productId,
      order_id: orderId,
      entitlement_id: entitlementId,
      status,
      currency,
      occurred_at: occurredAt,
      model_updated_at: modelUpdatedAt,
      last_event_sequence: lastEventSequence,
      snapshot: parseJson(snapshot)
    });
    return result([], 1);
  }
  if (command.startsWith("INSERT INTO COMMERCE_READ_MODEL_STATE")) {
    const [
      projectionName,
      projectionVersion,
      lastEventSequence,
      modelCount,
      modelsDigest
    ] = parameters;
    const record = {
      projection_name: projectionName,
      projection_version: projectionVersion,
      last_event_sequence: lastEventSequence,
      model_count: modelCount,
      models_digest: modelsDigest,
      updated_at: FIXED_TIME
    };
    const index = database.readModelState.findIndex((item) => item.projection_name === projectionName);
    if (index >= 0) database.readModelState[index] = record;
    else database.readModelState.push(record);
    return result([], 1);
  }
  throw new Error(`FakePool received unsupported SQL: ${command}`);
}

function emptyDatabase() {
  return {
    events: [],
    outbox: [],
    inbox: [],
    readModels: [],
    readModelState: [],
    nextEventSequence: 1,
    nextOutboxSequence: 1
  };
}

function normalizeSql(sql) {
  return sql.trim().replace(/\s+/g, " ").toUpperCase();
}

function parseJson(value) {
  return typeof value === "string" ? JSON.parse(value) : structuredClone(value);
}

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}
