import { createHash, randomUUID } from "node:crypto";
import {
  CommerceInvariantError,
  CommerceLedger,
  projectCreatorDashboard,
  projectDeliveries,
  projectEntitlement,
  projectOrder,
  projectRefunds
} from "./ledger.js";
import {
  projectCreatorPayouts,
  projectPayment,
  projectPayments,
  projectPayout,
  projectPayoutAccount,
  projectPayoutBalance
} from "./finance.js";

const ENVELOPE_FIELDS = [
  "event_id",
  "event_type",
  "occurred_at",
  "idempotency_key",
  "payload_digest"
];

const DEFAULT_ADVISORY_LOCK_KEY = 1_849_721_043;
const DEFAULT_OUTBOX_LEASE_MS = 60_000;
const READ_MODEL_PROJECTION = "commerce-v2";
const READ_MODEL_VERSION = 1;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS commerce_events (
    sequence BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_digest TEXT NOT NULL,
    payload JSONB NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS commerce_outbox (
    outbox_id BIGSERIAL PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES commerce_events(event_id) ON DELETE CASCADE,
    topic TEXT NOT NULL,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    locked_at TIMESTAMPTZ,
    lock_token TEXT,
    dispatched_at TIMESTAMPTZ,
    last_error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS commerce_outbox_pending_idx
    ON commerce_outbox (outbox_id)
    WHERE dispatched_at IS NULL`,
  `CREATE TABLE IF NOT EXISTS commerce_inbox (
    consumer_name TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    payload JSONB NOT NULL,
    result JSONB,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (consumer_name, idempotency_key)
  )`,
  `CREATE TABLE IF NOT EXISTS commerce_read_models (
    model_type TEXT NOT NULL,
    model_id TEXT NOT NULL,
    buyer_id TEXT,
    creator_id TEXT,
    product_id TEXT,
    order_id TEXT,
    entitlement_id TEXT,
    status TEXT,
    currency TEXT,
    occurred_at TIMESTAMPTZ,
    model_updated_at TIMESTAMPTZ,
    last_event_sequence BIGINT NOT NULL,
    snapshot JSONB NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
    projected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (model_type, model_id)
  )`,
  `CREATE INDEX IF NOT EXISTS commerce_read_models_buyer_idx
    ON commerce_read_models (buyer_id, model_type, status, occurred_at DESC)
    WHERE buyer_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS commerce_read_models_creator_idx
    ON commerce_read_models (creator_id, model_type, status, occurred_at DESC)
    WHERE creator_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS commerce_read_models_product_idx
    ON commerce_read_models (product_id, model_type)
    WHERE product_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS commerce_read_models_order_idx
    ON commerce_read_models (order_id, model_type)
    WHERE order_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS commerce_read_models_entitlement_idx
    ON commerce_read_models (entitlement_id, model_type)
    WHERE entitlement_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS commerce_read_model_state (
    projection_name TEXT PRIMARY KEY,
    projection_version INTEGER NOT NULL,
    last_event_sequence BIGINT NOT NULL,
    model_count INTEGER NOT NULL,
    models_digest TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`
];

/**
 * PostgreSQL-backed Commerce ledger.
 *
 * Queries intentionally stay synchronous, matching CommerceLedger: open() and
 * every append hydrates validated in-memory query snapshots, while writes
 * commit events, outbox rows and relational read models in one PostgreSQL
 * transaction. An advisory lock serializes logical writers so domain
 * invariants are evaluated against the latest committed event stream.
 *
 * The module does not import `pg`. Pass either an existing `pool`, or a `Pool`
 * constructor plus `connectionString`/`poolOptions`.
 */
export class PostgresCommerceLedger {
  #pool;
  #ownsPool;
  #closeInjectedPool;
  #events = [];
  #idempotency = new Map();
  #readModels = new Map();
  #readModelSequence = 0;
  #writeChain = Promise.resolve();
  #closed = false;

  constructor(options = {}) {
    const resolved = resolvePool(options);
    this.#pool = resolved.pool;
    this.#ownsPool = resolved.ownsPool;
    this.#closeInjectedPool = options.closePool === true;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((type) => `${type.replaceAll(".", "_")}_${randomUUID()}`);
    this.advisoryLockKey = options.advisoryLockKey ?? DEFAULT_ADVISORY_LOCK_KEY;
    if (!Number.isSafeInteger(this.advisoryLockKey)) {
      throw new TypeError("advisoryLockKey must be a safe integer");
    }
  }

  static async open(options = {}) {
    const ledger = new PostgresCommerceLedger(options);
    try {
      await ledger.#initialize();
      return ledger;
    } catch (error) {
      if (ledger.#ownsPool && typeof ledger.#pool.end === "function") {
        await ledger.#pool.end().catch(() => {});
      }
      throw error;
    }
  }

  listEvents() {
    return this.#events.map((event) => structuredClone(event));
  }

  findByIdempotencyKey(key) {
    const event = this.#idempotency.get(key);
    return event ? structuredClone(event) : undefined;
  }

  /**
   * Synchronous aggregate/read-model queries used by CommerceService. The
   * snapshots are loaded once at open/refresh and replaced only after the
   * transaction that wrote their source events commits. Audit events remain
   * available through listEvents(), but are not replayed for these queries.
   */
  readOrder(orderId, options = {}) {
    const order = this.#readModel("order", orderId);
    return order ? materializeOrderAt(order, projectionNow(options, this.clock)) : undefined;
  }

  readPayment(paymentId) {
    return this.#readModel("payment", paymentId);
  }

  readPayments(filters = {}) {
    return this.#listReadModels("payment")
      .filter((payment) => !filters.buyerId || payment.buyer_id === filters.buyerId)
      .filter((payment) => !filters.creatorId || payment.creator_id === filters.creatorId)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  readPayout(payoutId) {
    return this.#readModel("payout", payoutId);
  }

  readPayoutAccount(creatorId, currency = "USD") {
    const normalizedCurrency = String(currency ?? "USD").toUpperCase();
    return this.#readModel("payout_account", compoundModelId(creatorId, normalizedCurrency))
      ?? projectPayoutAccount([], creatorId, normalizedCurrency);
  }

  readPayoutAccounts(filters = {}) {
    const normalizedCurrency = filters.currency ? String(filters.currency).toUpperCase() : null;
    return this.#listReadModels("payout_account")
      .filter((account) => account.updated_at !== null)
      .filter((account) => !filters.creatorId || account.creator_id === filters.creatorId)
      .filter((account) => !normalizedCurrency || account.currency === normalizedCurrency)
      .filter((account) => !filters.status || account.status === filters.status)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  readPayoutBalance(creatorId, currency = "USD") {
    const normalizedCurrency = String(currency ?? "USD").toUpperCase();
    return this.#readModel("payout_balance", compoundModelId(creatorId, normalizedCurrency))
      ?? projectPayoutBalance([], creatorId, normalizedCurrency);
  }

  readCreatorPayouts(creatorId, currency) {
    const normalizedCurrency = currency ? String(currency).toUpperCase() : null;
    return this.#listReadModels("payout")
      .filter((payout) => payout.creator_id === creatorId)
      .filter((payout) => !normalizedCurrency || payout.currency === normalizedCurrency)
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  readEntitlement(entitlementId, options = {}) {
    const entitlement = this.#readModel("entitlement", entitlementId);
    return entitlement
      ? materializeEntitlementAt(entitlement, projectionNow(options, this.clock))
      : undefined;
  }

  readBuyerOrders(buyerId) {
    return this.#listReadModels("order")
      .filter((order) => order.buyer_id === buyerId)
      .map(buyerOrderFromSnapshot)
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }

  readBuyerEntitlements(buyerId, options = {}) {
    const now = projectionNow(options, this.clock);
    return this.#listReadModels("entitlement")
      .filter((entitlement) => entitlement.buyer_id === buyerId)
      .map((entitlement) => materializeEntitlementAt(entitlement, now))
      .sort((left, right) => left.granted_at.localeCompare(right.granted_at));
  }

  readCreatorOrders(creatorId, options = {}) {
    const now = projectionNow(options, this.clock);
    return this.#listReadModels("order")
      .filter((order) => order.creator_id === creatorId)
      .map((order) => materializeOrderAt(order, now))
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }

  readDeliveries(filters = {}) {
    return this.#listReadModels("delivery")
      .filter((delivery) => !filters.orderId || delivery.order_id === filters.orderId)
      .filter((delivery) => !filters.entitlementId || delivery.entitlement_id === filters.entitlementId)
      .filter((delivery) => !filters.creatorId || delivery.creator_id === filters.creatorId)
      .filter((delivery) => !filters.buyerId || delivery.buyer_id === filters.buyerId)
      .sort((left, right) => right.completed_at.localeCompare(left.completed_at));
  }

  readRefunds(filters = {}) {
    return this.#listReadModels("refund")
      .filter((refund) => !filters.orderId || refund.order_id === filters.orderId)
      .filter((refund) => !filters.creatorId || refund.creator_id === filters.creatorId)
      .filter((refund) => !filters.buyerId || refund.buyer_id === filters.buyerId)
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }

  readCreatorDashboard(creatorId) {
    return this.#readModel("creator_dashboard", creatorId)
      ?? projectCreatorDashboard([], creatorId);
  }

  readReservation(reservationId, options = {}) {
    const reservation = this.#readModel("reservation", reservationId);
    return reservation ? materializeReservationAt(reservation, projectionNow(options, this.clock)) : undefined;
  }

  readRevenues(filters = {}) {
    return this.#listReadModels("revenue")
      .filter((revenue) => !filters.orderId || revenue.order_id === filters.orderId)
      .filter((revenue) => !filters.deliveryId || revenue.delivery_id === filters.deliveryId)
      .filter((revenue) => !filters.creatorId || revenue.creator_id === filters.creatorId)
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }

  get readModelSequence() {
    return this.#readModelSequence;
  }

  async refresh() {
    return this.#enqueueWrite(async () => {
      this.#assertOpen();
      const state = await this.#loadConsistentState();
      this.#replaceState(state.events, state.readModels, state.sequence);
      return this.listEvents();
    });
  }

  async append(type, payload, options = {}) {
    const [event] = await this.appendMany([{ type, payload, ...options }]);
    return event;
  }

  async appendMany(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw new CommerceInvariantError("invalid_transaction", "appendMany requires at least one mutation");
    }
    return this.#enqueueWrite(async () => {
      this.#assertOpen();
      return this.#appendManyTransaction(mutations);
    });
  }

  /**
   * Atomically consumes one provider notification and mutates its aggregate.
   * The inbox record, events and outbox rows commit or roll back together.
   */
  async appendManyFromInbox(consumerName, idempotencyKey, payload, mutations, options = {}) {
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw new CommerceInvariantError("invalid_transaction", "appendManyFromInbox requires mutations");
    }
    requiredString(consumerName, "consumerName");
    requiredString(idempotencyKey, "idempotencyKey");
    const safePayload = jsonRoundTrip(payload ?? {}, "inbox payload");
    const resultPayload = jsonRoundTrip(options.result ?? null, "inbox result");
    return this.#enqueueWrite(async () => {
      this.#assertOpen();
      return this.#appendManyFromInboxTransaction(
        consumerName,
        idempotencyKey,
        safePayload,
        resultPayload,
        mutations
      );
    });
  }

  /** Returns pending outbox rows without claiming them. */
  async listPendingOutbox(options = {}) {
    this.#assertOpen();
    const limit = positiveInteger(options.limit ?? 100, "limit");
    const result = await this.#pool.query(
      `SELECT outbox_id, event_id, topic, payload, attempts, created_at,
              locked_at, dispatched_at, last_error
         FROM commerce_outbox
        WHERE dispatched_at IS NULL
        ORDER BY outbox_id
        LIMIT $1`,
      [limit]
    );
    return result.rows.map(rowToOutbox);
  }

  /**
   * Claims and dispatches a bounded outbox batch. The short claim transaction
   * avoids holding a database transaction open while user/network code runs.
   * Failed records remain pending and become immediately retryable.
   */
  async dispatchOutbox(dispatcher, options = {}) {
    this.#assertOpen();
    if (typeof dispatcher !== "function") throw new TypeError("dispatcher must be a function");
    const limit = positiveInteger(options.limit ?? 100, "limit");
    const leaseMs = positiveInteger(options.leaseMs ?? DEFAULT_OUTBOX_LEASE_MS, "leaseMs");
    const lockToken = randomUUID();
    const client = await acquireClient(this.#pool);
    let rows;
    try {
      await client.query("BEGIN");
      const claimed = await client.query(
        `WITH pending AS (
           SELECT outbox_id
             FROM commerce_outbox
            WHERE dispatched_at IS NULL
              AND (locked_at IS NULL OR locked_at < NOW() - ($2::double precision * INTERVAL '1 millisecond'))
            ORDER BY outbox_id
            FOR UPDATE SKIP LOCKED
            LIMIT $1
         )
         UPDATE commerce_outbox AS item
            SET locked_at = NOW(),
                lock_token = $3,
                attempts = item.attempts + 1
           FROM pending
          WHERE item.outbox_id = pending.outbox_id
         RETURNING item.outbox_id, item.event_id, item.topic, item.payload,
                   item.attempts, item.created_at, item.locked_at,
                   item.dispatched_at, item.last_error`,
        [limit, leaseMs, lockToken]
      );
      rows = claimed.rows;
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }

    const report = { claimed: rows.length, dispatched: 0, failed: 0, errors: [] };
    for (const row of rows) {
      const item = rowToOutbox(row);
      try {
        await dispatcher(structuredClone(item.payload), {
          outbox_id: item.outbox_id,
          event_id: item.event_id,
          topic: item.topic,
          attempt: item.attempts
        });
        await this.#pool.query(
          `UPDATE commerce_outbox
              SET dispatched_at = NOW(), locked_at = NULL, lock_token = NULL, last_error = NULL
            WHERE outbox_id = $1 AND lock_token = $2 AND dispatched_at IS NULL`,
          [item.outbox_id, lockToken]
        );
        report.dispatched += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.#pool.query(
          `UPDATE commerce_outbox
              SET locked_at = NULL, lock_token = NULL, last_error = $3
            WHERE outbox_id = $1 AND lock_token = $2 AND dispatched_at IS NULL`,
          [item.outbox_id, lockToken, message]
        );
        report.failed += 1;
        report.errors.push({ outbox_id: item.outbox_id, event_id: item.event_id, message });
      }
    }
    return report;
  }

  /**
   * Records an inbound side effect exactly once per consumer/key. Replaying the
   * same payload returns the original record; changing the payload fails.
   */
  async markInbox(consumerName, idempotencyKey, payload, options = {}) {
    this.#assertOpen();
    requiredString(consumerName, "consumerName");
    requiredString(idempotencyKey, "idempotencyKey");
    const safePayload = jsonRoundTrip(payload ?? {}, "inbox payload");
    const digest = genericPayloadDigest(safePayload);
    const resultPayload = jsonRoundTrip(options.result ?? null, "inbox result");
    const inserted = await this.#pool.query(
      `INSERT INTO commerce_inbox (
         consumer_name, idempotency_key, payload_digest, payload, result
       ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       ON CONFLICT (consumer_name, idempotency_key) DO NOTHING
       RETURNING consumer_name, idempotency_key, payload_digest, payload, result, processed_at`,
      [consumerName, idempotencyKey, digest, JSON.stringify(safePayload), JSON.stringify(resultPayload)]
    );
    if (inserted.rowCount === 1) {
      return { ...rowToInbox(inserted.rows[0]), inserted: true, replay: false };
    }

    const existing = await this.#pool.query(
      `SELECT consumer_name, idempotency_key, payload_digest, payload, result, processed_at
         FROM commerce_inbox
        WHERE consumer_name = $1 AND idempotency_key = $2`,
      [consumerName, idempotencyKey]
    );
    if (existing.rowCount !== 1) {
      throw new Error("Inbox record disappeared after an idempotency conflict");
    }
    const record = rowToInbox(existing.rows[0]);
    if (record.payload_digest !== digest) {
      throw new CommerceInvariantError(
        "inbox_idempotency_conflict",
        `Inbox key ${consumerName}/${idempotencyKey} was already used with a different payload`
      );
    }
    return { ...record, inserted: false, replay: true };
  }

  async findInbox(consumerName, idempotencyKey) {
    this.#assertOpen();
    requiredString(consumerName, "consumerName");
    requiredString(idempotencyKey, "idempotencyKey");
    const result = await this.#pool.query(
      `SELECT consumer_name, idempotency_key, payload_digest, payload, result, processed_at
         FROM commerce_inbox
        WHERE consumer_name = $1 AND idempotency_key = $2`,
      [consumerName, idempotencyKey]
    );
    return result.rowCount === 1 ? rowToInbox(result.rows[0]) : undefined;
  }

  async close() {
    if (this.#closed) return;
    await this.#writeChain.catch(() => {});
    this.#closed = true;
    if ((this.#ownsPool || this.#closeInjectedPool) && typeof this.#pool.end === "function") {
      await this.#pool.end();
    }
  }

  async #initialize() {
    for (const migration of MIGRATIONS) await this.#pool.query(migration);
    const state = await this.#loadConsistentState();
    this.#replaceState(state.events, state.readModels, state.sequence);
  }

  async #loadConsistentState() {
    const client = await acquireClient(this.#pool);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [this.advisoryLockKey]);
      const events = await this.#readAndValidateEvents(client);
      const sequence = await readLastEventSequence(client);
      const readModels = await loadOrRebuildReadModels(client, events, sequence, this.clock);
      await client.query("COMMIT");
      return { events, readModels, sequence };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #appendManyTransaction(mutations) {
    const client = await acquireClient(this.#pool);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [this.advisoryLockKey]);
      const existingEvents = await this.#readEvents(client);
      const existingIds = new Set(existingEvents.map((event) => event.event_id));
      const validator = await validatorFromEvents(existingEvents, {
        clock: this.clock,
        idFactory: this.idFactory
      });
      const results = await validator.appendMany(mutations);
      const nextEvents = validator.listEvents();
      const newEvents = nextEvents.filter((event) => !existingIds.has(event.event_id));

      for (const event of newEvents) {
        const payload = eventPayload(event);
        const payloadJson = jsonDocument(payload, "commerce event payload");
        const eventJson = jsonDocument(event, "commerce outbox payload");
        await client.query(
          `INSERT INTO commerce_events (
             event_id, event_type, occurred_at, idempotency_key, payload_digest, payload
           ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
          [
            event.event_id,
            event.event_type,
            event.occurred_at,
            event.idempotency_key,
            event.payload_digest,
            payloadJson
          ]
        );
        await client.query(
          `INSERT INTO commerce_outbox (event_id, topic, payload)
           VALUES ($1, $2, $3::jsonb)`,
          [event.event_id, event.event_type, eventJson]
        );
      }

      const sequence = await readLastEventSequence(client);
      const readModels = buildReadModels(nextEvents, clockDate(this.clock));
      await replaceReadModels(client, readModels, sequence);

      await client.query("COMMIT");
      this.#replaceState(nextEvents, readModels, sequence);
      return results.map((event) => structuredClone(event));
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #appendManyFromInboxTransaction(consumerName, idempotencyKey, payload, resultPayload, mutations) {
    const client = await acquireClient(this.#pool);
    const digest = genericPayloadDigest(payload);
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [this.advisoryLockKey]);
      const existingInbox = await client.query(
        `SELECT consumer_name, idempotency_key, payload_digest, payload, result, processed_at
           FROM commerce_inbox
          WHERE consumer_name = $1 AND idempotency_key = $2`,
        [consumerName, idempotencyKey]
      );
      if (existingInbox.rowCount === 1) {
        const record = rowToInbox(existingInbox.rows[0]);
        if (record.payload_digest !== digest) {
          throw new CommerceInvariantError(
            "inbox_idempotency_conflict",
            `Inbox key ${consumerName}/${idempotencyKey} was already used with a different payload`
          );
        }
        const currentEvents = await this.#readEvents(client);
        const validator = await validatorFromEvents(currentEvents, {
          clock: this.clock,
          idFactory: this.idFactory
        });
        const results = await validator.appendMany(mutations);
        const nextEvents = validator.listEvents();
        if (nextEvents.length !== currentEvents.length) {
          throw new CommerceInvariantError(
            "inbox_aggregate_mismatch",
            `Inbox ${consumerName}/${idempotencyKey} exists without its aggregate mutation`
          );
        }
        const sequence = await readLastEventSequence(client);
        const readModels = await loadOrRebuildReadModels(client, nextEvents, sequence, this.clock);
        await client.query("COMMIT");
        this.#replaceState(nextEvents, readModels, sequence);
        return {
          inserted: false,
          replay: true,
          inbox: record,
          events: results.map((event) => structuredClone(event))
        };
      }

      const existingEvents = await this.#readEvents(client);
      const existingIds = new Set(existingEvents.map((event) => event.event_id));
      const validator = await validatorFromEvents(existingEvents, {
        clock: this.clock,
        idFactory: this.idFactory
      });
      const results = await validator.appendMany(mutations);
      const nextEvents = validator.listEvents();
      const newEvents = nextEvents.filter((event) => !existingIds.has(event.event_id));
      for (const event of newEvents) {
        await insertEventAndOutbox(client, event);
      }
      const storedResult = resultPayload ?? {
        event_ids: results.map((event) => event.event_id)
      };
      const inserted = await client.query(
        `INSERT INTO commerce_inbox (
           consumer_name, idempotency_key, payload_digest, payload, result
         ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
         RETURNING consumer_name, idempotency_key, payload_digest, payload, result, processed_at`,
        [consumerName, idempotencyKey, digest, JSON.stringify(payload), JSON.stringify(storedResult)]
      );
      const sequence = await readLastEventSequence(client);
      const readModels = buildReadModels(nextEvents, clockDate(this.clock));
      await replaceReadModels(client, readModels, sequence);
      await client.query("COMMIT");
      this.#replaceState(nextEvents, readModels, sequence);
      return {
        inserted: true,
        replay: false,
        inbox: rowToInbox(inserted.rows[0]),
        events: results.map((event) => structuredClone(event))
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async #readAndValidateEvents(queryable) {
    const events = await this.#readEvents(queryable);
    await validatorFromEvents(events, { clock: this.clock, idFactory: this.idFactory });
    return events;
  }

  async #readEvents(queryable) {
    const result = await queryable.query(
      `SELECT event_id, event_type, occurred_at, idempotency_key, payload_digest, payload
         FROM commerce_events
        ORDER BY sequence`
    );
    return result.rows.map(rowToEvent);
  }

  #replaceState(events, readModels = [], sequence = 0) {
    this.#events = events.map((event) => Object.freeze(structuredClone(event)));
    this.#idempotency = new Map(this.#events.map((event) => [event.idempotency_key, event]));
    this.#readModels = new Map(readModels.map((model) => [
      readModelKey(model.model_type, model.model_id),
      Object.freeze(structuredClone(model.snapshot))
    ]));
    this.#readModelSequence = Number(sequence);
  }

  #readModel(type, id) {
    this.#assertOpen();
    const snapshot = this.#readModels.get(readModelKey(type, id));
    return snapshot ? structuredClone(snapshot) : undefined;
  }

  #listReadModels(type) {
    this.#assertOpen();
    const prefix = `${type}\0`;
    return [...this.#readModels.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, snapshot]) => structuredClone(snapshot));
  }

  #enqueueWrite(operation) {
    const next = this.#writeChain.catch(() => {}).then(operation);
    this.#writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  #assertOpen() {
    if (this.#closed) throw new Error("PostgresCommerceLedger is closed");
  }
}

async function loadOrRebuildReadModels(client, events, sequence, clock) {
  const stateResult = await client.query(
    `SELECT projection_name, projection_version, last_event_sequence,
            model_count, models_digest, updated_at
       FROM commerce_read_model_state
      WHERE projection_name = $1`,
    [READ_MODEL_PROJECTION]
  );
  if (stateResult.rowCount === 1) {
    const state = stateResult.rows[0];
    const stored = await readStoredModels(client);
    if (
      Number(state.projection_version) === READ_MODEL_VERSION
      && Number(state.last_event_sequence) === sequence
      && Number(state.model_count) === stored.length
      && state.models_digest === readModelsDigest(stored)
    ) {
      return stored;
    }
  }

  // This is both the initial migration and the deterministic repair path. Old
  // deployments can retain their audit events; opening the repository
  // backfills all query snapshots under the same writer lock.
  const rebuilt = buildReadModels(events, clockDate(clock));
  await replaceReadModels(client, rebuilt, sequence);
  return rebuilt;
}

async function readStoredModels(queryable) {
  const result = await queryable.query(
    `SELECT model_type, model_id, buyer_id, creator_id, product_id,
            order_id, entitlement_id, status, currency, occurred_at,
            model_updated_at, last_event_sequence, snapshot
       FROM commerce_read_models
      ORDER BY model_type, model_id`
  );
  return result.rows.map(rowToReadModel);
}

async function replaceReadModels(client, readModels, sequence) {
  await client.query("DELETE FROM commerce_read_models");
  for (const model of readModels) {
    await client.query(
      `INSERT INTO commerce_read_models (
         model_type, model_id, buyer_id, creator_id, product_id,
         order_id, entitlement_id, status, currency, occurred_at,
         model_updated_at, last_event_sequence, snapshot
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb
       )`,
      [
        model.model_type,
        model.model_id,
        model.buyer_id,
        model.creator_id,
        model.product_id,
        model.order_id,
        model.entitlement_id,
        model.status,
        model.currency,
        model.occurred_at,
        model.model_updated_at,
        sequence,
        jsonDocument(model.snapshot, `${model.model_type} read model`)
      ]
    );
  }
  await client.query(
    `INSERT INTO commerce_read_model_state (
       projection_name, projection_version, last_event_sequence,
       model_count, models_digest, updated_at
     ) VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (projection_name) DO UPDATE SET
       projection_version = EXCLUDED.projection_version,
       last_event_sequence = EXCLUDED.last_event_sequence,
       model_count = EXCLUDED.model_count,
       models_digest = EXCLUDED.models_digest,
       updated_at = NOW()`,
    [
      READ_MODEL_PROJECTION,
      READ_MODEL_VERSION,
      sequence,
      readModels.length,
      readModelsDigest(readModels)
    ]
  );
}

async function readLastEventSequence(queryable) {
  const result = await queryable.query(
    "SELECT COALESCE(MAX(sequence), 0) AS last_event_sequence FROM commerce_events"
  );
  const sequence = Number(result.rows[0]?.last_event_sequence ?? 0);
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new CommerceInvariantError("corrupt_ledger", "Invalid commerce event sequence watermark");
  }
  return sequence;
}

function buildReadModels(events, now) {
  const models = [];
  const add = (modelType, modelId, snapshot) => {
    if (!snapshot) return;
    const safeSnapshot = readModelSnapshot(snapshot, `${modelType} read model`);
    models.push({
      model_type: modelType,
      model_id: String(modelId),
      buyer_id: nullableString(safeSnapshot.buyer_id),
      creator_id: nullableString(safeSnapshot.creator_id),
      product_id: nullableString(safeSnapshot.product_id),
      order_id: nullableString(safeSnapshot.order_id ?? (modelType === "order" ? modelId : null)),
      entitlement_id: nullableString(
        safeSnapshot.entitlement_id ?? (modelType === "entitlement" ? modelId : null)
      ),
      status: nullableString(safeSnapshot.status),
      currency: nullableString(safeSnapshot.currency)?.toUpperCase() ?? null,
      occurred_at: firstTimestamp(safeSnapshot, [
        "occurred_at", "created_at", "granted_at", "completed_at", "reserved_at", "updated_at"
      ]),
      model_updated_at: firstTimestamp(safeSnapshot, [
        "updated_at", "completed_at", "occurred_at", "created_at", "granted_at", "reserved_at"
      ]),
      snapshot: safeSnapshot
    });
  };

  for (const orderId of eventIds(events, "order.placed", "order_id")) {
    const order = projectOrder(events, orderId, { now });
    const timeline = events
      .filter((event) => event.order_id === orderId)
      .map((event) => ({
        event_id: event.event_id,
        type: event.event_type,
        occurred_at: event.occurred_at
      }))
      .sort((left, right) => left.occurred_at.localeCompare(right.occurred_at));
    add("order", orderId, { ...order, timeline });
  }

  for (const entitlementId of eventIds(events, "entitlement.granted", "entitlement_id")) {
    const entitlement = projectEntitlement(events, entitlementId, { now });
    add("entitlement", entitlementId, entitlement);
    for (const reservation of entitlement?.reservations ?? []) {
      add("reservation", reservation.reservation_id, {
        ...reservation,
        order_id: entitlement.order_id,
        buyer_id: entitlement.buyer_id,
        creator_id: entitlement.creator_id,
        agent_id: entitlement.agent_id,
        product_id: entitlement.product_id,
        purchased_corpus_digest: entitlement.purchased_corpus_digest
      });
    }
  }

  for (const delivery of projectDeliveries(events)) add("delivery", delivery.delivery_id, delivery);
  for (const refund of projectRefunds(events)) add("refund", refund.refund_id, refund);
  for (const payment of projectPayments(events)) add("payment", payment.payment_id, payment);

  for (const payoutId of eventIds(events, "payout.reserved", "payout_id")) {
    add("payout", payoutId, projectPayout(events, payoutId));
  }

  for (const creatorId of uniqueStrings(events.map((event) => event.creator_id))) {
    add("creator_dashboard", creatorId, projectCreatorDashboard(events, creatorId));
  }

  const payoutPairs = uniquePairs(
    events.filter((event) => (
      event.creator_id
      && event.currency
      && (event.event_type.startsWith("payout.") || event.event_type.startsWith("revenue."))
    )),
    "creator_id",
    "currency",
    (currency) => currency.toUpperCase()
  );
  for (const [creatorId, currency] of payoutPairs) {
    add(
      "payout_account",
      compoundModelId(creatorId, currency),
      projectPayoutAccount(events, creatorId, currency)
    );
    add(
      "payout_balance",
      compoundModelId(creatorId, currency),
      projectPayoutBalance(events, creatorId, currency)
    );
  }

  for (const recognized of events.filter((event) => event.event_type === "revenue.recognized")) {
    const reversal = events.find((event) => (
      event.event_type === "revenue.reversed"
      && event.recognition_id === recognized.recognition_id
    ));
    add("revenue", recognized.recognition_id, {
      ...structuredClone(recognized),
      status: reversal ? "reversed" : "recognized",
      reversal_id: reversal?.reversal_id ?? null,
      reversed_at: reversal?.occurred_at ?? null
    });
  }

  for (const adjustment of events.filter((event) => event.event_type === "payout.adjustment")) {
    add("payout_adjustment", adjustment.adjustment_id, {
      ...structuredClone(adjustment),
      status: "applied"
    });
  }

  return models.sort((left, right) => (
    left.model_type.localeCompare(right.model_type) || left.model_id.localeCompare(right.model_id)
  ));
}

function rowToReadModel(row) {
  const snapshot = jsonValue(row.snapshot);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new CommerceInvariantError("corrupt_read_model", "Persisted Commerce read model must be an object");
  }
  return {
    model_type: row.model_type,
    model_id: row.model_id,
    buyer_id: row.buyer_id ?? null,
    creator_id: row.creator_id ?? null,
    product_id: row.product_id ?? null,
    order_id: row.order_id ?? null,
    entitlement_id: row.entitlement_id ?? null,
    status: row.status ?? null,
    currency: row.currency ?? null,
    occurred_at: row.occurred_at ? timestamp(row.occurred_at, "occurred_at") : null,
    model_updated_at: row.model_updated_at ? timestamp(row.model_updated_at, "model_updated_at") : null,
    last_event_sequence: Number(row.last_event_sequence),
    snapshot: structuredClone(snapshot)
  };
}

function readModelSnapshot(value, field) {
  assertFiniteJsonNumbers(value, field, new Set());
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new CommerceInvariantError("invalid_read_model", `${field} must be JSON serializable: ${error.message}`);
  }
  const snapshot = JSON.parse(serialized);
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new CommerceInvariantError("invalid_read_model", `${field} must be an object`);
  }
  return snapshot;
}

function assertFiniteJsonNumbers(value, field, seen) {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new CommerceInvariantError("invalid_read_model", `${field} cannot contain non-finite numbers`);
  }
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new CommerceInvariantError("invalid_read_model", `${field} cannot contain circular values`);
  }
  seen.add(value);
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    assertFiniteJsonNumbers(nested, field, seen);
  }
  seen.delete(value);
}

function readModelsDigest(readModels) {
  return genericPayloadDigest(readModels.map((model) => ({
    model_type: model.model_type,
    model_id: model.model_id,
    buyer_id: model.buyer_id,
    creator_id: model.creator_id,
    product_id: model.product_id,
    order_id: model.order_id,
    entitlement_id: model.entitlement_id,
    status: model.status,
    currency: model.currency,
    occurred_at: model.occurred_at,
    model_updated_at: model.model_updated_at,
    snapshot: model.snapshot
  })));
}

function eventIds(events, eventType, field) {
  return uniqueStrings(events
    .filter((event) => event.event_type === eventType)
    .map((event) => event[field]));
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value))];
}

function uniquePairs(events, leftField, rightField, normalizeRight = (value) => value) {
  const pairs = new Map();
  for (const event of events) {
    const left = event[leftField];
    const right = event[rightField];
    if (typeof left !== "string" || !left || typeof right !== "string" || !right) continue;
    const normalizedRight = normalizeRight(right);
    pairs.set(compoundModelId(left, normalizedRight), [left, normalizedRight]);
  }
  return [...pairs.values()];
}

function compoundModelId(...parts) {
  return JSON.stringify(parts);
}

function readModelKey(type, id) {
  return `${type}\0${String(id)}`;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function firstTimestamp(snapshot, fields) {
  for (const field of fields) {
    if (!snapshot[field]) continue;
    return timestamp(snapshot[field], field);
  }
  return null;
}

function projectionNow(options, clock) {
  if (options.now !== undefined) {
    const value = options.now instanceof Date ? options.now : new Date(options.now);
    if (Number.isNaN(value.getTime())) throw new TypeError("now must be a valid timestamp");
    return value.toISOString();
  }
  return clockDate(clock).toISOString();
}

function materializeReservationAt(reservation, now) {
  if (
    reservation.status === "reserved"
    && reservation.expires_at
    && Date.parse(reservation.expires_at) <= Date.parse(now)
  ) {
    return { ...reservation, status: "expired", completed_at: reservation.expires_at };
  }
  return reservation;
}

function materializeEntitlementAt(entitlement, now) {
  const reservations = (entitlement.reservations ?? [])
    .map((reservation) => materializeReservationAt(reservation, now));
  const reservedUnits = reservations
    .filter((reservation) => reservation.status === "reserved")
    .reduce((sum, reservation) => sum + reservation.reserved_units, 0);
  const consumedUnits = reservations
    .filter((reservation) => reservation.status === "consumed")
    .reduce((sum, reservation) => sum + reservation.reserved_units, 0);
  const grantedUnits = entitlement.granted_units;
  const status = entitlement.status === "revoked"
    ? "revoked"
    : consumedUnits >= grantedUnits
      ? "consumed"
      : entitlement.valid_until && Date.parse(entitlement.valid_until) <= Date.parse(now)
        ? "expired"
        : "active";
  return {
    ...entitlement,
    status,
    reserved_units: reservedUnits,
    consumed_units: consumedUnits,
    remaining_units: Math.max(0, grantedUnits - reservedUnits - consumedUnits),
    reservations
  };
}

function materializeOrderAt(order, now) {
  return {
    ...order,
    entitlement: order.entitlement
      ? materializeEntitlementAt(order.entitlement, now)
      : null
  };
}

function buyerOrderFromSnapshot(order) {
  const buyerOrder = {
    order_id: order.order_id,
    creator_id: order.creator_id,
    agent_id: order.agent_id,
    product_id: order.product_id,
    corpus_digest: order.corpus_digest,
    product_name: order.product_name ?? null,
    gross_minor: order.gross_minor,
    currency: order.currency,
    status: order.status,
    payment_status: order.payment_status,
    payment_id: order.payment_id,
    occurred_at: order.occurred_at,
    entitlement_id: order.entitlement?.entitlement_id ?? null
  };
  if (order.creator_display_name) buyerOrder.creator_display_name = order.creator_display_name;
  if (order.payment) buyerOrder.payment = structuredClone(order.payment);
  return buyerOrder;
}

async function validatorFromEvents(events, options) {
  let replayClock;
  const validator = await CommerceLedger.open({
    clock: () => replayClock ?? clockDate(options.clock),
    idFactory: options.idFactory
  });
  for (const event of events) {
    replayClock = new Date(event.occurred_at);
    let replayed;
    try {
      replayed = await validator.replayPersistedEvent(event);
    } catch (error) {
      throw corruptLedgerError(error);
    }
    if (replayed.payload_digest !== event.payload_digest) {
      throw new CommerceInvariantError(
        "corrupt_ledger",
        `Persisted payload digest does not match event ${event.event_id}`
      );
    }
  }
  replayClock = undefined;
  return validator;
}

async function insertEventAndOutbox(client, event) {
  const payload = eventPayload(event);
  const payloadJson = jsonDocument(payload, "commerce event payload");
  const eventJson = jsonDocument(event, "commerce outbox payload");
  await client.query(
    `INSERT INTO commerce_events (
       event_id, event_type, occurred_at, idempotency_key, payload_digest, payload
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
    [
      event.event_id,
      event.event_type,
      event.occurred_at,
      event.idempotency_key,
      event.payload_digest,
      payloadJson
    ]
  );
  await client.query(
    `INSERT INTO commerce_outbox (event_id, topic, payload)
     VALUES ($1, $2, $3::jsonb)`,
    [event.event_id, event.event_type, eventJson]
  );
}

function rowToEvent(row) {
  const payload = jsonValue(row.payload);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CommerceInvariantError("corrupt_ledger", "Persisted commerce event payload must be an object");
  }
  return {
    ...structuredClone(payload),
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: timestamp(row.occurred_at, "occurred_at"),
    idempotency_key: row.idempotency_key,
    payload_digest: row.payload_digest
  };
}

function rowToOutbox(row) {
  return {
    outbox_id: String(row.outbox_id),
    event_id: row.event_id,
    topic: row.topic,
    payload: structuredClone(jsonValue(row.payload)),
    attempts: Number(row.attempts),
    created_at: timestamp(row.created_at, "created_at"),
    locked_at: row.locked_at ? timestamp(row.locked_at, "locked_at") : null,
    dispatched_at: row.dispatched_at ? timestamp(row.dispatched_at, "dispatched_at") : null,
    last_error: row.last_error ?? null
  };
}

function rowToInbox(row) {
  return {
    consumer_name: row.consumer_name,
    idempotency_key: row.idempotency_key,
    payload_digest: row.payload_digest,
    payload: structuredClone(jsonValue(row.payload)),
    result: structuredClone(jsonValue(row.result)),
    processed_at: timestamp(row.processed_at, "processed_at")
  };
}

function eventPayload(event) {
  const payload = structuredClone(event);
  for (const field of ENVELOPE_FIELDS) delete payload[field];
  return payload;
}

function resolvePool(options) {
  if (options.pool) {
    if (typeof options.pool.query !== "function") throw new TypeError("pool.query must be a function");
    return { pool: options.pool, ownsPool: false };
  }
  if (typeof options.Pool !== "function") {
    throw new TypeError("PostgresCommerceLedger requires either pool or Pool");
  }
  const poolOptions = options.connectionString || options.poolOptions
    ? { ...(options.connectionString ? { connectionString: options.connectionString } : {}), ...options.poolOptions }
    : undefined;
  return { pool: new options.Pool(poolOptions), ownsPool: true };
}

async function acquireClient(pool) {
  if (typeof pool.connect === "function") {
    const client = await pool.connect();
    if (!client || typeof client.query !== "function") throw new TypeError("pool.connect() must return a queryable client");
    return {
      query: client.query.bind(client),
      release: typeof client.release === "function" ? client.release.bind(client) : () => {}
    };
  }
  return { query: pool.query.bind(pool), release: () => {} };
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original transaction error.
  }
}

function corruptLedgerError(cause) {
  const error = new CommerceInvariantError(
    "corrupt_ledger",
    `Persisted commerce event stream is invalid: ${cause instanceof Error ? cause.message : String(cause)}`
  );
  error.cause = cause;
  return error;
}

function genericPayloadDigest(payload) {
  return `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function jsonValue(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    // `pg` returns a JSONB scalar string as the already-decoded string.
    return value;
  }
}

function jsonRoundTrip(value, field) {
  return JSON.parse(jsonDocument(value, field));
}

function jsonDocument(value, field) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new CommerceInvariantError("invalid_event", `${field} must be JSON serializable: ${error.message}`);
  }
  if (serialized === undefined) {
    throw new CommerceInvariantError("invalid_event", `${field} must be JSON serializable`);
  }
  const stored = JSON.parse(serialized);
  if (canonicalJson(stored) !== canonicalJson(value)) {
    throw new CommerceInvariantError("invalid_event", `${field} cannot contain undefined or non-finite values`);
  }
  return serialized;
}

function timestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new CommerceInvariantError("corrupt_ledger", `Invalid ${field} timestamp`);
  }
  return date.toISOString();
}

function clockDate(clock) {
  const value = clock();
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("clock must return a valid date");
  return date;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) throw new TypeError(`${field} must be a positive integer`);
  return value;
}

function requiredString(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
}
