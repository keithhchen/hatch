import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 20;

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
  constructor(code, message, options) {
    super(message, options);
    this.name = "CommerceInvariantError";
    this.code = code;
  }
}

export class CommercePersistenceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "CommercePersistenceError";
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
    this.lockTimeoutMs = positiveIntegerOption(options.lockTimeoutMs, DEFAULT_LOCK_TIMEOUT_MS, "lockTimeoutMs");
    this.lockPollMs = positiveIntegerOption(options.lockPollMs, DEFAULT_LOCK_POLL_MS, "lockPollMs");
  }

  static async open(options = {}) {
    const ledger = new CommerceLedger(options);
    if (!options.filePath) return ledger;
    ledger.#replaceSnapshot(await readLedgerSnapshot(options.filePath));
    return ledger;
  }

  listEvents() {
    this.#refreshSnapshotSync();
    return this.#events.map((event) => structuredClone(event));
  }

  findByIdempotencyKey(key) {
    this.#refreshSnapshotSync();
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
    const operation = this.#writeChain.then(() => this.#appendSerialized(type, payload, options));
    // A failed persistence attempt must not poison all later operations on
    // this instance. Callers still receive the original rejection.
    this.#writeChain = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async #appendSerialized(type, payload, options) {
    if (!this.filePath) {
      return this.#appendToSnapshot(type, payload, options, this.#events);
    }
    return withLedgerLock(this.filePath, {
      timeoutMs: this.lockTimeoutMs,
      pollMs: this.lockPollMs
    }, async () => {
      const events = await readLedgerSnapshot(this.filePath);
      this.#replaceSnapshot(events);
      const result = this.#appendToSnapshot(type, payload, options, events, { ingest: false });
      if (result.existing) return result.event;
      const nextEvents = validateLedgerSnapshot([...events, result.event]);
      await persistLedgerSnapshot(this.filePath, nextEvents);
      this.#replaceSnapshot(nextEvents);
      return structuredClone(result.event);
    });
  }

  #appendToSnapshot(type, payload, options, events, behavior = {}) {
    const existing = events.find((event) => event.idempotency_key === options.idempotencyKey);
    if (existing) {
      const incomingDigest = payloadDigest(type, payload);
      if (existing.payload_digest !== incomingDigest) {
        throw new CommerceInvariantError(
          "idempotency_conflict",
          `Idempotency key ${options.idempotencyKey} was already used with a different payload`
        );
      }
      return behavior.ingest === false
        ? { existing: true, event: structuredClone(existing) }
        : structuredClone(existing);
    }
    const event = {
      ...structuredClone(payload),
      event_id: options.eventId ?? this.idFactory(type),
      event_type: type,
      occurred_at: this.clock().toISOString(),
      idempotency_key: options.idempotencyKey,
      payload_digest: payloadDigest(type, payload)
    };
    validateEvent(event, events);
    if (events.some((candidate) => candidate.event_id === event.event_id)) {
      throw new CommerceInvariantError("duplicate_event_id", `Duplicate event id: ${event.event_id}`);
    }
    if (behavior.ingest === false) return { existing: false, event };
    this.#ingest(event, { replay: false });
    return structuredClone(event);
  }

  #refreshSnapshotSync() {
    if (!this.filePath) return;
    this.#replaceSnapshot(readLedgerSnapshotSync(this.filePath));
  }

  #replaceSnapshot(events) {
    const validated = validateLedgerSnapshot(events);
    this.#events = [];
    this.#eventIds = new Set();
    this.#idempotency = new Map();
    for (const event of validated) this.#ingest(event, { replay: true });
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
    const stored = Object.freeze(structuredClone(event));
    this.#events.push(stored);
    this.#eventIds.add(stored.event_id);
    this.#idempotency.set(stored.idempotency_key, stored);
  }
}

async function readLedgerSnapshot(filePath) {
  try {
    return parseLedgerContent(await readFile(filePath, "utf8"), filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function readLedgerSnapshotSync(filePath) {
  try {
    return parseLedgerContent(readFileSync(filePath, "utf8"), filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function parseLedgerContent(content, filePath) {
  const events = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new CommerceInvariantError(
        "corrupt_ledger",
        `Commerce ledger ${filePath} has invalid JSON on line ${index + 1}`,
        { cause: error }
      );
    }
  }
  return validateLedgerSnapshot(events);
}

function validateLedgerSnapshot(events) {
  const validated = [];
  const eventIds = new Set();
  const idempotencyKeys = new Set();
  for (const rawEvent of events) {
    if (!rawEvent || typeof rawEvent !== "object" || Array.isArray(rawEvent)) {
      throw new CommerceInvariantError("corrupt_ledger", "Commerce ledger contains a non-object event");
    }
    const event = structuredClone(rawEvent);
    if (!EVENT_TYPES.has(event.event_type)) {
      throw new CommerceInvariantError("corrupt_ledger", `Unsupported persisted commerce event: ${event.event_type}`);
    }
    if (eventIds.has(event.event_id)) {
      throw new CommerceInvariantError("corrupt_ledger", `Duplicate event id: ${event.event_id}`);
    }
    if (idempotencyKeys.has(event.idempotency_key)) {
      throw new CommerceInvariantError("corrupt_ledger", `Duplicate idempotency key: ${event.idempotency_key}`);
    }
    validateEvent(event, validated);
    validated.push(Object.freeze(event));
    eventIds.add(event.event_id);
    idempotencyKeys.add(event.idempotency_key);
  }
  return validated;
}

async function persistLedgerSnapshot(filePath, events) {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  const serialized = events.length > 0
    ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    : "";
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    throw new CommercePersistenceError(
      "ledger_persist_failed",
      `Could not atomically persist commerce ledger ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    // Some development filesystems do not support directory fsync. The file
    // itself was fsynced before atomic rename; production Linux volumes do.
    if (!["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function withLedgerLock(filePath, options, operation) {
  const lockPath = `${filePath}.lock`;
  await mkdir(path.dirname(filePath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new CommercePersistenceError(
          "ledger_lock_failed",
          `Could not acquire commerce ledger lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new CommercePersistenceError(
          "ledger_lock_timeout",
          `Timed out waiting for commerce ledger lock ${lockPath}. Locks are never auto-stolen; after verifying no Dashboard or Runtime writer is active, remove this lock directory manually.`
        );
      }
      await delay(options.pollMs);
    }
  }

  try {
    await writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify({
      hostname: hostname(),
      pid: process.pid,
      acquired_at: new Date().toISOString()
    })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
    throw new CommercePersistenceError(
      "ledger_lock_failed",
      `Could not initialize commerce ledger lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  try {
    return await operation();
  } finally {
    try {
      await rm(lockPath, { recursive: true });
    } catch (error) {
      throw new CommercePersistenceError(
        "ledger_lock_release_failed",
        `Could not release commerce ledger lock ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}

function positiveIntegerOption(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new CommerceInvariantError("invalid_ledger_option", `${name} must be a positive integer`);
  }
  return resolved;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
      status: refundedOrders.has(order.order_id) ? "refunded" : revenue ? "delivered" : "paid",
      creator_share_minor: refundedOrders.has(order.order_id) ? 0 : revenue?.creator_share_minor ?? 0,
      hatch_share_minor: refundedOrders.has(order.order_id) ? 0 : revenue?.hatch_share_minor ?? 0,
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
  for (const key of ["event_id", "event_type", "occurred_at", "idempotency_key", "payload_digest"]) {
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
