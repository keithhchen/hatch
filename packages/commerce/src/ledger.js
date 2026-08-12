import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const EVENT_TYPES = new Set([
  "order.placed",
  "entitlement.granted",
  "task.started",
  "artifact.created",
  "delivery.completed",
  "revenue.recognized",
  "order.refunded"
]);

export class CommerceInvariantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CommerceInvariantError";
    this.code = code;
  }
}

export class CommerceLedger {
  #events = [];
  #eventIds = new Set();
  #idempotency = new Map();
  #writeChain = Promise.resolve();

  constructor(options = {}) {
    this.filePath = options.filePath;
    this.clock = options.clock ?? (() => new Date());
    this.idFactory = options.idFactory ?? ((type) => `${type.replaceAll(".", "_")}_${randomUUID()}`);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.staleLockMs = options.staleLockMs ?? 30000;
  }

  static async open(options = {}) {
    const ledger = new CommerceLedger(options);
    if (!options.filePath) return ledger;
    let content = "";
    try {
      content = await readFile(options.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      ledger.#ingest(JSON.parse(line), { replay: true });
    }
    return ledger;
  }

  listEvents() {
    this.#reloadFromDiskSync();
    return this.#events.map((event) => structuredClone(event));
  }

  findByIdempotencyKey(key) {
    this.#reloadFromDiskSync();
    const event = this.#idempotency.get(key);
    return event ? structuredClone(event) : undefined;
  }

  async append(type, payload, options = {}) {
    if (!EVENT_TYPES.has(type)) {
      throw new CommerceInvariantError("unknown_event_type", `Unsupported commerce event: ${type}`);
    }
    return this.#enqueueWrite(async () => {
      const releaseLock = this.filePath ? await acquireFileLock(this.filePath, {
        timeoutMs: this.lockTimeoutMs,
        staleLockMs: this.staleLockMs
      }) : async () => {};
      try {
        if (this.filePath) await this.#reloadFromDisk();
        const stagedEvents = this.#events.map((event) => structuredClone(event));
        const stagedIds = new Set(this.#eventIds);
        const stagedIdempotency = new Map(this.#idempotency);
        const results = [];

        for (const mutation of mutations) {
          const type = mutation?.type;
          const idempotencyKey = mutation?.idempotencyKey;
          assertMutation(type, idempotencyKey);
          const normalizedPayload = normalizePayload(type, mutation?.payload ?? {}, idempotencyKey);
          assertPayloadEnvelope(normalizedPayload);
          const existing = stagedIdempotency.get(idempotencyKey);
          if (existing) {
            const incomingDigest = payloadDigest(type, normalizedPayload);
            const replayDigest = payloadDigest(type, normalizePayload(type, eventPayload(existing), idempotencyKey));
            if (existing.payload_digest !== incomingDigest && replayDigest !== incomingDigest) {
              throw new CommerceInvariantError(
                "idempotency_conflict",
                `Idempotency key ${idempotencyKey} was already used with a different payload`
              );
            }
            results.push(structuredClone(existing));
            continue;
          }

          const event = {
            ...normalizedPayload,
            event_id: mutation.eventId ?? this.idFactory(type),
            event_type: type,
            occurred_at: this.clock().toISOString(),
            idempotency_key: idempotencyKey,
            payload_digest: payloadDigest(type, normalizedPayload)
          };
          if (stagedIds.has(event.event_id)) {
            throw new CommerceInvariantError("duplicate_event_id", `Duplicate event id: ${event.event_id}`);
          }
          validateEvent(event, stagedEvents);
          stagedEvents.push(Object.freeze(structuredClone(event)));
          stagedIds.add(event.event_id);
          stagedIdempotency.set(idempotencyKey, event);
          results.push(structuredClone(event));
        }

        if (this.filePath && results.some((event) => !this.#eventIds.has(event.event_id))) {
          await persistEventsAtomically(this.filePath, stagedEvents);
        }
        this.#replaceState(stagedEvents);
        return results;
      } finally {
        await releaseLock();
      }
    });
  }

  #ingest(event, { replay }) {
    if (this.#eventIds.has(event.event_id)) {
      throw new CommerceInvariantError("duplicate_event_id", `Duplicate event id: ${event.event_id}`);
    }
    if (this.#idempotency.has(event.idempotency_key)) {
      throw new CommerceInvariantError(
        replay ? "corrupt_ledger" : "duplicate_idempotency_key",
        `Duplicate idempotency key: ${event.idempotency_key}`
      );
    }
    this.#events.push(Object.freeze(structuredClone(event)));
    this.#eventIds.add(event.event_id);
    this.#idempotency.set(event.idempotency_key, event);
  }
}

export function projectBuyerEntitlements(events, buyerId) {
  const refundedOrders = new Set(events
    .filter((event) => event.event_type === "order.refunded")
    .map((event) => event.order_id));
  return events
    .filter((event) => event.event_type === "entitlement.granted" && event.buyer_id === buyerId)
    .filter((event) => !refundedOrders.has(event.order_id))
    .map((event) => ({
      entitlement_id: event.entitlement_id,
      order_id: event.order_id,
      creator_id: event.creator_id,
      agent_id: event.agent_id,
      product_id: event.product_id,
      corpus_digest: event.corpus_digest,
      status: "active"
    }));
}

export function projectBuyerOrders(events, buyerId) {
  const refundedOrders = new Set(events
    .filter((event) => event.event_type === "order.refunded")
    .map((event) => event.order_id));
  return events
    .filter((event) => event.event_type === "order.placed" && event.buyer_id === buyerId)
    .map((event) => ({
      order_id: event.order_id,
      creator_id: event.creator_id,
      agent_id: event.agent_id,
      product_id: event.product_id,
      corpus_digest: event.corpus_digest,
      product_name: event.product_name ?? null,
      gross_minor: event.gross_minor,
      currency: event.currency,
      status: refundedOrders.has(event.order_id) ? "refunded" : "paid",
      payment_status: event.payment_status ?? "paid",
      payment_id: event.payment_id ?? null,
      occurred_at: event.occurred_at,
      entitlement_id: events.find((candidate) => (
        candidate.event_type === "entitlement.granted" && candidate.order_id === event.order_id
      ))?.entitlement_id ?? null
    }))
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

export function projectCreatorDashboard(events, creatorId) {
  const creatorEvents = events.filter((event) => event.creator_id === creatorId);
  const orders = new Map();
  const entitlements = new Map();
  const tasks = new Map();
  const artifacts = new Map();
  const deliveries = new Map();
  const recognized = new Map();
  const refundedOrders = new Set();
  for (const event of creatorEvents) {
    if (event.event_type === "order.placed") orders.set(event.order_id, event);
    if (event.event_type === "entitlement.granted") entitlements.set(event.order_id, event);
    if (event.event_type === "task.started") tasks.set(event.order_id, event);
    if (event.event_type === "artifact.created") artifacts.set(event.order_id, event);
    if (event.event_type === "delivery.completed") deliveries.set(event.order_id, event);
    if (event.event_type === "revenue.recognized") recognized.set(event.order_id, event);
    if (event.event_type === "order.refunded") refundedOrders.add(event.order_id);
  }
  const visibleOrders = [...orders.values()].map((order) => {
    const revenue = recognized.get(order.order_id);
    const entitlement = entitlements.get(order.order_id);
    const task = tasks.get(order.order_id);
    const artifact = artifacts.get(order.order_id);
    const delivery = deliveries.get(order.order_id);
    return {
      order_id: order.order_id,
      product_id: order.product_id,
      buyer_display_name: order.buyer_display_name,
      product_name: order.product_name ?? null,
      gross_minor: order.gross_minor,
      currency: order.currency,
      status: refundedOrders.has(order.order_id) ? "refunded" : delivery ? "delivered" : "paid",
      creator_share_minor: creatorShareMinor,
      hatch_share_minor: hatchShareMinor,
      occurred_at: order.occurred_at,
      agent_id: order.agent_id,
      corpus_digest: order.corpus_digest,
      entitlement_id: entitlement?.entitlement_id ?? null,
      task_id: task?.task_id ?? null,
      artifact_id: artifact?.artifact_id ?? null,
      artifact_digest: artifact?.artifact_digest ?? null,
      delivery_id: delivery?.delivery_id ?? null,
      recognition_id: revenue?.recognition_id ?? null
    };
  });
  const activeRevenue = visibleOrders.filter((order) => order.status !== "refunded");
  return {
    creator_id: creatorId,
    metrics: {
      orders: visibleOrders.length,
      successful_deliveries: [...deliveries.values()].filter((delivery) => !refundedOrders.has(delivery.order_id)).length,
      gross_minor: activeRevenue.reduce((sum, order) => sum + order.gross_minor, 0),
      creator_share_minor: activeRevenue.reduce((sum, order) => sum + order.creator_share_minor, 0),
      hatch_share_minor: activeRevenue.reduce((sum, order) => sum + order.hatch_share_minor, 0)
    },
    orders: visibleOrders.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
  };
}

function payloadDigest(type, payload) {
  return `sha256:${createHash("sha256").update(canonicalJson({ type, payload })).digest("hex")}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function validateEvent(event, events) {
  for (const key of ["event_id", "event_type", "occurred_at", "idempotency_key"]) {
    if (typeof event[key] !== "string" || !event[key]) {
      throw new CommerceInvariantError("invalid_event", `${key} is required`);
    }
  }
  if (event.event_type === "order.placed") {
    requireFields(event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency"]);
    requireNonNegativeInteger(event.gross_minor, "gross_minor");
  }
  if (event.event_type === "entitlement.granted") {
    requireFields(event, ["entitlement_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    const order = requirePrior(events, "order.placed", "order_id", event.order_id);
    requireIdentityMatch(order, event, ["buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
  }
  if (event.event_type === "task.started") {
    requireFields(event, ["task_id", "order_id", "entitlement_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    const entitlement = requirePrior(events, "entitlement.granted", "entitlement_id", event.entitlement_id);
    requireIdentityMatch(entitlement, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
  }
  if (event.event_type === "artifact.created") {
    requireFields(event, ["artifact_id", "task_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest", "artifact_digest"]);
    const task = requirePrior(events, "task.started", "task_id", event.task_id);
    requireIdentityMatch(task, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
  }
  if (event.event_type === "delivery.completed") {
    requireFields(event, ["delivery_id", "artifact_id", "task_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    const artifact = requirePrior(events, "artifact.created", "artifact_id", event.artifact_id);
    requireIdentityMatch(artifact, event, ["task_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    if (events.some((item) => item.event_type === "delivery.completed" && item.task_id === event.task_id)) {
      throw new CommerceInvariantError("task_already_delivered", `Task ${event.task_id} already has a Delivery`);
    }
  }
  if (event.event_type === "revenue.recognized") {
    requireFields(event, ["recognition_id", "delivery_id", "order_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency"]);
    const delivery = requirePrior(events, "delivery.completed", "delivery_id", event.delivery_id);
    requireIdentityMatch(delivery, event, ["order_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    requirePositiveInteger(event.gross_minor, "gross_minor");
    requireNonNegativeInteger(event.creator_share_minor, "creator_share_minor");
    requireNonNegativeInteger(event.hatch_share_minor, "hatch_share_minor");
    if (event.creator_share_minor + event.hatch_share_minor !== event.gross_minor) {
      throw new CommerceInvariantError("invalid_split", "Creator and Hatch shares must equal gross revenue");
    }
    if (events.some((item) => item.event_type === "revenue.recognized" && item.order_id === event.order_id)) {
      throw new CommerceInvariantError("revenue_already_recognized", `Order ${event.order_id} already recognized revenue`);
    }
  }
  if (event.event_type === "order.refunded") {
    requireFields(event, ["refund_id", "order_id", "buyer_id", "creator_id", "product_id", "currency"]);
    requirePrior(events, "order.placed", "order_id", event.order_id);
    requirePositiveInteger(event.gross_minor, "gross_minor");
  }
}

function requireFields(event, fields) {
  for (const field of fields) {
    if (typeof event[field] !== "string" || !event[field]) {
      throw new CommerceInvariantError("invalid_event", `${event.event_type}.${field} is required`);
    }
  }
}

function requirePrior(events, type, key, value) {
  const prior = events.find((event) => event.event_type === type && event[key] === value);
  if (!prior) {
    throw new CommerceInvariantError("missing_prior_event", `${type} with ${key}=${value} is required`);
  }
  return prior;
}

function requireIdentityMatch(prior, event, fields) {
  for (const field of fields) {
    if (prior[field] !== event[field]) {
      throw new CommerceInvariantError(
        "identity_chain_mismatch",
        `${event.event_type}.${field} must match prior ${prior.event_type}`,
      );
    }
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CommerceInvariantError("invalid_amount", `${field} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommerceInvariantError("invalid_amount", `${field} must be a non-negative integer`);
  }
}
