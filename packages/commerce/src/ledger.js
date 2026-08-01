import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
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
    return this.#events.map((event) => structuredClone(event));
  }

  findByIdempotencyKey(key) {
    const event = this.#idempotency.get(key);
    return event ? structuredClone(event) : undefined;
  }

  async append(type, payload, options = {}) {
    if (!EVENT_TYPES.has(type)) {
      throw new CommerceInvariantError("unknown_event_type", `Unsupported commerce event: ${type}`);
    }
    if (!options.idempotencyKey?.trim()) {
      throw new CommerceInvariantError("idempotency_required", "Every commerce mutation requires an idempotency key");
    }
    const existing = this.#idempotency.get(options.idempotencyKey);
    if (existing) {
      const incomingDigest = payloadDigest(type, payload);
      if (existing.payload_digest !== incomingDigest) {
        throw new CommerceInvariantError(
          "idempotency_conflict",
          `Idempotency key ${options.idempotencyKey} was already used with a different payload`
        );
      }
      return structuredClone(existing);
    }
    const event = {
      event_id: options.eventId ?? this.idFactory(type),
      event_type: type,
      occurred_at: this.clock().toISOString(),
      idempotency_key: options.idempotencyKey,
      payload_digest: payloadDigest(type, payload),
      ...structuredClone(payload)
    };
    validateEvent(event, this.#events);
    this.#ingest(event, { replay: false });
    if (this.filePath) {
      const line = `${JSON.stringify(event)}\n`;
      this.#writeChain = this.#writeChain.then(async () => {
        await mkdir(path.dirname(this.filePath), { recursive: true });
        await appendFile(this.filePath, line, "utf8");
      });
      await this.#writeChain;
    }
    return structuredClone(event);
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
      product_id: event.product_id,
      release_id: event.release_id,
      release_digest: event.release_digest,
      status: "active"
    }));
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
      status: refundedOrders.has(order.order_id) ? "refunded" : revenue ? "delivered" : "paid",
      creator_share_minor: refundedOrders.has(order.order_id) ? 0 : revenue?.creator_share_minor ?? 0,
      hatch_share_minor: refundedOrders.has(order.order_id) ? 0 : revenue?.hatch_share_minor ?? 0,
      occurred_at: order.occurred_at,
      release_id: order.release_id,
      release_digest: order.release_digest,
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
    requireFields(event, ["order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest", "currency"]);
    requirePositiveInteger(event.gross_minor, "gross_minor");
  }
  if (event.event_type === "entitlement.granted") {
    requireFields(event, ["entitlement_id", "order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
    const order = requirePrior(events, "order.placed", "order_id", event.order_id);
    requireIdentityMatch(order, event, ["buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
  }
  if (event.event_type === "task.started") {
    requireFields(event, ["task_id", "order_id", "entitlement_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
    const entitlement = requirePrior(events, "entitlement.granted", "entitlement_id", event.entitlement_id);
    requireIdentityMatch(entitlement, event, ["order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
  }
  if (event.event_type === "artifact.created") {
    requireFields(event, ["artifact_id", "task_id", "order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest", "artifact_digest"]);
    const task = requirePrior(events, "task.started", "task_id", event.task_id);
    requireIdentityMatch(task, event, ["order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
  }
  if (event.event_type === "delivery.completed") {
    requireFields(event, ["delivery_id", "artifact_id", "task_id", "order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
    const artifact = requirePrior(events, "artifact.created", "artifact_id", event.artifact_id);
    requireIdentityMatch(artifact, event, ["task_id", "order_id", "buyer_id", "creator_id", "product_id", "release_id", "release_digest"]);
    if (events.some((item) => item.event_type === "delivery.completed" && item.task_id === event.task_id)) {
      throw new CommerceInvariantError("task_already_delivered", `Task ${event.task_id} already has a Delivery`);
    }
  }
  if (event.event_type === "revenue.recognized") {
    requireFields(event, ["recognition_id", "delivery_id", "order_id", "creator_id", "product_id", "release_id", "release_digest", "currency"]);
    const delivery = requirePrior(events, "delivery.completed", "delivery_id", event.delivery_id);
    requireIdentityMatch(delivery, event, ["order_id", "creator_id", "product_id", "release_id", "release_digest"]);
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
