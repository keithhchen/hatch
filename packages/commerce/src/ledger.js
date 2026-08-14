import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PAYMENT_STATUSES,
  projectPayment,
  projectPayout,
  projectPayoutBalance
} from "./finance.js";

const EVENT_TYPES = new Set([
  "payment.created",
  "payment.status_changed",
  "payment.refunded",
  "order.placed",
  "entitlement.granted",
  "entitlement.units_reserved",
  "entitlement.units_consumed",
  "entitlement.units_released",
  "entitlement.version_advanced",
  "entitlement.revoked",
  "task.started",
  "artifact.created",
  "delivery.completed",
  "revenue.recognized",
  "revenue.reversed",
  "order.refunded",
  "payout.adjustment",
  "payout.account_updated",
  "payout.reserved",
  "payout.submitted",
  "payout.in_transit",
  "payout.paid",
  "payout.failed",
  "payout.reconciliation_failed",
  "payout.retried"
]);

// Offer events are no longer part of the Commerce write model. They remain in
// append-only ledgers created by older releases, so the explicit persisted
// replay path below preserves them for audit/history without allowing new
// offer mutations or projecting them as current access state.
const RETIRED_EVENT_TYPES = new Set([
  "offer.revision_created",
  "offer.activated"
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
    const [event] = await this.appendMany([{ type, payload, ...options }]);
    return event;
  }

  /**
   * Atomically appends a related group of events. Replaying a fully committed
   * group returns the original events; a conflicting reuse of any key fails the
   * whole group. File-backed ledgers serialize writers through a short-lived
   * lock and replace the JSONL source atomically, so independently opened
   * instances cannot lose each other's writes.
   */
  async appendMany(mutations) {
    if (!Array.isArray(mutations) || mutations.length === 0) {
      throw new CommerceInvariantError("invalid_transaction", "appendMany requires at least one mutation");
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

  /**
   * Rehydrates one event already persisted by an older Commerce release.
   *
   * This is intentionally separate from append()/appendMany(): retired Offer
   * events can cross the read-time migration boundary, but can never be
   * created by the current write API. Current events still go through the
   * normal domain validator while retired events are envelope/digest checked
   * and retained only for audit ordering.
   */
  async replayPersistedEvent(event) {
    assertPersistedEnvelope(event);
    const type = event.event_type;
    if (RETIRED_EVENT_TYPES.has(type)) {
      const payload = eventPayload(event);
      const expectedDigest = payloadDigest(type, payload);
      if (event.payload_digest !== expectedDigest) {
        throw new CommerceInvariantError(
          "corrupt_ledger",
          `Persisted payload digest does not match event ${event.event_id}`
        );
      }
      this.#ingest(event, { replay: true });
      return structuredClone(event);
    }

    const replayed = await this.append(type, eventPayload(event), {
      eventId: event.event_id,
      idempotencyKey: event.idempotency_key
    });
    if (
      replayed.occurred_at !== event.occurred_at
      || replayed.payload_digest !== event.payload_digest
    ) {
      throw new CommerceInvariantError(
        "corrupt_ledger",
        `Persisted event envelope does not match event ${event.event_id}`
      );
    }
    return replayed;
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

  #enqueueWrite(operation) {
    const next = this.#writeChain.catch(() => {}).then(operation);
    this.#writeChain = next.then(() => undefined, () => undefined);
    return next;
  }

  async #reloadFromDisk() {
    const events = await readEvents(this.filePath);
    this.#replaceState(events);
  }

  #reloadFromDiskSync() {
    if (!this.filePath) return;
    let content = "";
    try {
      content = readFileSync(this.filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    this.#replaceState(parseEvents(content));
  }

  #replaceState(events) {
    this.#events = [];
    this.#eventIds = new Set();
    this.#idempotency = new Map();
    for (const event of events) this.#ingest(event, { replay: true });
  }
}

export function projectBuyerEntitlements(events, buyerId) {
  return events
    .filter((event) => event.event_type === "entitlement.granted" && event.buyer_id === buyerId)
    .filter((event) => projectEntitlement(events, event.entitlement_id)?.status !== "revoked")
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
  const refundedMinorByOrder = new Map();
  const refundedOrders = new Set();
  for (const event of events.filter((event) => isConfirmedRefundEvent(events, event))) {
    refundedMinorByOrder.set(event.order_id, (refundedMinorByOrder.get(event.order_id) ?? 0) + event.gross_minor);
    refundedOrders.add(event.order_id);
  }
  return events
    .filter((event) => event.event_type === "order.placed" && event.buyer_id === buyerId)
    .map((event) => {
      const refundedMinor = refundedMinorByOrder.get(event.order_id) ?? 0;
      const payment = event.payment_id ? projectPayment(events, event.payment_id) : null;
      const entitlement = events.find((candidate) => (
        candidate.event_type === "entitlement.granted" && candidate.order_id === event.order_id
      ));
      return ({
        order_id: event.order_id,
        creator_id: event.creator_id,
        ...(event.creator_display_name ? { creator_display_name: event.creator_display_name } : {}),
        agent_id: event.agent_id,
        product_id: event.product_id,
        corpus_digest: event.corpus_digest,
        product_name: event.product_name ?? null,
        gross_minor: event.gross_minor,
        subtotal_minor: event.subtotal_minor ?? event.gross_minor,
        discount_minor: event.discount_minor ?? 0,
        tax_minor: event.tax_minor ?? null,
        total_minor: event.total_minor ?? event.gross_minor,
        currency: event.currency,
        status: event.gross_minor === 0 && refundedOrders.has(event.order_id)
          ? "cancelled"
          : refundedMinor >= event.gross_minor && refundedMinor > 0
          ? "refunded"
          : refundedMinor > 0
            ? "partially_refunded"
            : entitlement
              ? "fulfilled"
            : "paid",
        payment_status: event.gross_minor === 0
          ? "not_required"
          : payment?.settlement_status ?? event.payment_status ?? "paid",
        payment_id: event.gross_minor === 0 ? null : event.payment_id ?? null,
        ...(payment ? { payment } : {}),
        occurred_at: event.occurred_at,
        entitlement_id: entitlement?.entitlement_id ?? null
      });
    })
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
  const reversed = new Map();
  const refundedOrders = new Set();
  for (const event of creatorEvents) {
    if (event.event_type === "order.placed") orders.set(event.order_id, event);
    if (event.event_type === "entitlement.granted") entitlements.set(event.order_id, event);
    if (event.event_type === "task.started") pushByOrder(tasks, event);
    if (event.event_type === "artifact.created") pushByOrder(artifacts, event);
    if (event.event_type === "delivery.completed") pushByOrder(deliveries, event);
    if (event.event_type === "revenue.recognized") pushByOrder(recognized, event);
    if (event.event_type === "revenue.reversed") pushByOrder(reversed, event);
    if (isConfirmedRefundEvent(events, event)) refundedOrders.add(event.order_id);
  }
  const visibleOrders = [...orders.values()].map((order) => {
    const revenueEvents = recognized.get(order.order_id) ?? [];
    const reversalEvents = reversed.get(order.order_id) ?? [];
    const revenue = revenueEvents.at(-1);
    const entitlement = entitlements.get(order.order_id);
    const task = tasks.get(order.order_id)?.at(-1);
    const artifact = artifacts.get(order.order_id)?.at(-1);
    const deliveryEvents = deliveries.get(order.order_id) ?? [];
    const delivery = deliveryEvents.at(-1);
    const creatorShareMinor = revenueEvents.reduce((sum, event) => sum + event.creator_share_minor, 0)
      - reversalEvents.reduce((sum, event) => sum + event.creator_share_minor, 0);
    const hatchShareMinor = revenueEvents.reduce((sum, event) => sum + event.hatch_share_minor, 0)
      - reversalEvents.reduce((sum, event) => sum + event.hatch_share_minor, 0);
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
      delivery_count: deliveryEvents.length,
      recognition_id: revenue?.recognition_id ?? null
    };
  });
  return {
    creator_id: creatorId,
    metrics: {
      orders: visibleOrders.length,
      successful_deliveries: [...deliveries.entries()]
        .filter(([orderId]) => !refundedOrders.has(orderId))
        .reduce((sum, [, orderDeliveries]) => sum + orderDeliveries.length, 0),
      gross_minor: visibleOrders
        .filter((order) => order.status !== "refunded")
        .reduce((sum, order) => sum + order.gross_minor, 0),
      creator_share_minor: visibleOrders.reduce((sum, order) => sum + order.creator_share_minor, 0),
      hatch_share_minor: visibleOrders.reduce((sum, order) => sum + order.hatch_share_minor, 0)
    },
    orders: visibleOrders.sort((left, right) => right.occurred_at.localeCompare(left.occurred_at))
  };
}

/** Returns a complete order/receipt projection, or undefined when absent. */
export function projectOrder(events, orderId, options = {}) {
  const order = events.find((event) => event.event_type === "order.placed" && event.order_id === orderId);
  if (!order) return undefined;
  const entitlementGrant = events.find((event) => (
    event.event_type === "entitlement.granted" && event.order_id === orderId
  ));
  const entitlement = entitlementGrant
    ? projectEntitlement(events, entitlementGrant.entitlement_id, options)
    : null;
  const deliveries = projectDeliveries(events, { orderId });
  const refunds = projectRefunds(events, { orderId });
  const revenue = events
    .filter((event) => event.event_type === "revenue.recognized" && event.order_id === orderId)
    .map((event) => {
      const reversal = events.find((candidate) => (
        candidate.event_type === "revenue.reversed"
        && candidate.recognition_id === event.recognition_id
      ));
      return {
        ...structuredClone(event),
        status: reversal ? "reversed" : "recognized",
        reversal_id: reversal?.reversal_id ?? null
      };
    });
  const revenueReversals = events
    .filter((event) => event.event_type === "revenue.reversed" && event.order_id === orderId)
    .map((event) => structuredClone(event));
  const payoutAdjustments = events
    .filter((event) => event.event_type === "payout.adjustment" && event.order_id === orderId)
    .map((event) => structuredClone(event));
  const timeline = events
    .filter((event) => event.order_id === orderId)
    .map((event) => ({
      event_id: event.event_id,
      type: event.event_type,
      occurred_at: event.occurred_at
    }))
    .sort((left, right) => String(left.occurred_at ?? "").localeCompare(String(right.occurred_at ?? "")));
  const payment = order.payment_id ? projectPayment(events, order.payment_id) : null;
  const refundedMinor = refunds.reduce((sum, refund) => sum + refund.gross_minor, 0);
  const status = order.gross_minor === 0 && refunds.length > 0
    ? "cancelled"
    : refundedMinor >= order.gross_minor && refundedMinor > 0
    ? "refunded"
    : refunds.length > 0
      ? "partially_refunded"
      : entitlement
        ? "fulfilled"
        : "paid";
  return {
    order_id: order.order_id,
    order_line_id: order.order_line_id ?? `${order.order_id}:line:1`,
    buyer_id: order.buyer_id,
    buyer_display_name: order.buyer_display_name ?? null,
    creator_id: order.creator_id,
    creator_display_name: order.creator_display_name ?? null,
    creator_snapshot: order.creator_snapshot ?? null,
    agent_id: order.agent_id,
    product_id: order.product_id,
    product_name: order.product_name ?? null,
    product_snapshot: order.product_snapshot ?? null,
    corpus_digest: order.corpus_digest,
    release_id: order.release_id ?? null,
    release_snapshot: order.release_snapshot ?? null,
    gross_minor: order.gross_minor,
    subtotal_minor: order.subtotal_minor ?? order.gross_minor,
    discount_minor: order.discount_minor ?? 0,
    tax_minor: order.tax_minor ?? null,
    total_minor: order.total_minor ?? order.gross_minor,
    currency: order.currency,
    included_units: order.included_units ?? 1,
    refund_policy_version: order.refund_policy_version ?? null,
    payment_status: order.gross_minor === 0
      ? "not_required"
      : payment?.settlement_status ?? order.payment_status ?? "paid",
    payment_id: order.gross_minor === 0 ? null : order.payment_id ?? null,
    payment,
    status,
    occurred_at: order.occurred_at,
    entitlement,
    deliveries,
    revenue,
    revenue_reversals: revenueReversals,
    payout_adjustments: payoutAdjustments,
    refunds,
    timeline
  };
}

/**
 * Projects authoritative delivery-unit availability. Reserved units are
 * excluded from remaining_units until consumed, released, or their lease
 * expires. Expiry is visible immediately even before the reconciler persists
 * the corresponding release event.
 */
export function projectEntitlement(events, entitlementId, options = {}) {
  const grant = events.find((event) => (
    event.event_type === "entitlement.granted" && event.entitlement_id === entitlementId
  ));
  if (!grant) return undefined;

  const purchasedCorpusDigest = grant.purchased_corpus_digest ?? grant.corpus_digest;
  const versionHistory = events
    .filter((event) => (
      event.event_type === "entitlement.version_advanced"
      && event.entitlement_id === entitlementId
    ))
    .map((event) => ({
      event_id: event.event_id,
      from_digest: event.from_digest,
      to_digest: event.to_digest,
      from_release_id: event.from_release_id ?? null,
      to_release_id: event.to_release_id ?? null,
      compatibility_declaration_id: event.compatibility_declaration_id ?? null,
      reason: event.reason ?? null,
      actor_id: event.actor_id ?? null,
      advanced_at: event.occurred_at
    }));
  const effectiveCorpusDigest = versionHistory.at(-1)?.to_digest ?? purchasedCorpusDigest;

  const reservationEvents = events.filter((event) => (
    event.entitlement_id === entitlementId && (
      event.event_type === "entitlement.units_reserved" ||
      event.event_type === "entitlement.units_consumed" ||
      event.event_type === "entitlement.units_released"
    )
  ));
  const projectionNow = projectionTimestamp(options);
  const reservations = new Map();
  for (const event of reservationEvents) {
    const previous = reservations.get(event.reservation_id);
    if (event.event_type === "entitlement.units_reserved") {
      const expiresAt = reservationExpiresAt(event);
      reservations.set(event.reservation_id, {
        reservation_id: event.reservation_id,
        entitlement_id: event.entitlement_id,
        run_id: event.run_id,
        task_id: event.task_id ?? event.run_id,
        effective_corpus_digest: event.effective_corpus_digest ?? event.corpus_digest,
        reserved_units: event.units,
        status: "reserved",
        reserved_at: event.occurred_at,
        expires_at: expiresAt,
        completed_at: null,
        delivery_id: null
      });
    }
    if (previous && event.event_type === "entitlement.units_consumed") {
      reservations.set(event.reservation_id, {
        ...previous,
        status: "consumed",
        completed_at: event.occurred_at,
        delivery_id: event.delivery_id
      });
    }
    if (previous && event.event_type === "entitlement.units_released") {
      reservations.set(event.reservation_id, {
        ...previous,
        status: "released",
        completed_at: event.occurred_at
      });
    }
  }

  const reservationList = [...reservations.values()].map((reservation) => (
    reservation.status === "reserved"
      && reservation.expires_at
      && Date.parse(reservation.expires_at) <= projectionNow
      ? {
          ...reservation,
          status: "expired",
          completed_at: reservation.expires_at
        }
      : reservation
  ));
  const reservedUnits = reservationList
    .filter((reservation) => reservation.status === "reserved")
    .reduce((sum, reservation) => sum + reservation.reserved_units, 0);
  const consumedUnits = reservationList
    .filter((reservation) => reservation.status === "consumed")
    .reduce((sum, reservation) => sum + reservation.reserved_units, 0);
  const grantedUnits = grant.granted_units ?? 1;
  const remainingUnits = Math.max(0, grantedUnits - reservedUnits - consumedUnits);
  const order = events.find((event) => event.event_type === "order.placed" && event.order_id === grant.order_id);
  const refundedMinor = events
    .filter((event) => event.order_id === grant.order_id && isConfirmedRefundEvent(events, event))
    .reduce((sum, event) => sum + event.gross_minor, 0);
  const revoked = events.some((event) => (
    event.entitlement_id === entitlementId && isEffectiveRevocation(events, event)
  )) || Boolean(order && order.gross_minor > 0 && refundedMinor >= order.gross_minor);
  const expired = Boolean(grant.expires_at && Date.parse(grant.expires_at) <= projectionNow);
  const status = revoked
    ? "revoked"
    : consumedUnits >= grantedUnits
      ? "consumed"
      : expired
        ? "expired"
        : "active";

  return {
    entitlement_id: grant.entitlement_id,
    order_id: grant.order_id,
    order_line_id: grant.order_line_id ?? `${grant.order_id}:line:1`,
    buyer_id: grant.buyer_id,
    creator_id: grant.creator_id,
    agent_id: grant.agent_id,
    product_id: grant.product_id,
    corpus_digest: purchasedCorpusDigest,
    purchased_corpus_digest: purchasedCorpusDigest,
    effective_corpus_digest: effectiveCorpusDigest,
    purchased_release_id: grant.purchased_release_id ?? grant.release_id ?? null,
    version_policy: grant.version_policy ?? "pinned",
    granted_units: grantedUnits,
    reserved_units: reservedUnits,
    consumed_units: consumedUnits,
    remaining_units: remainingUnits,
    status,
    granted_at: grant.occurred_at,
    valid_from: grant.valid_from ?? grant.occurred_at,
    valid_until: grant.expires_at ?? null,
    expires_at: grant.expires_at ?? null,
    version_history: versionHistory,
    reservations: reservationList
  };
}

export function projectDeliveries(events, filters = {}) {
  return events
    .filter((event) => event.event_type === "delivery.completed")
    .filter((event) => !filters.orderId || event.order_id === filters.orderId)
    .filter((event) => !filters.entitlementId || event.entitlement_id === filters.entitlementId)
    .filter((event) => !filters.creatorId || event.creator_id === filters.creatorId)
    .filter((event) => !filters.buyerId || event.buyer_id === filters.buyerId)
    .map((event) => {
      const revenue = events.find((candidate) => (
        candidate.event_type === "revenue.recognized" && candidate.delivery_id === event.delivery_id
      ));
      const order = events.find((candidate) => (
        candidate.event_type === "order.placed" && candidate.order_id === event.order_id
      ));
      return {
        delivery_id: event.delivery_id,
        order_id: event.order_id,
        entitlement_id: event.entitlement_id ?? null,
        reservation_id: event.reservation_id ?? null,
        task_id: event.task_id,
        artifact_id: event.artifact_id,
        artifact_type: event.artifact_type ?? null,
        artifact_digest: events.find((candidate) => (
          candidate.event_type === "artifact.created" && candidate.artifact_id === event.artifact_id
        ))?.artifact_digest ?? null,
        buyer_id: event.buyer_id,
        creator_id: event.creator_id,
        agent_id: event.agent_id,
        product_id: event.product_id,
        purchased_corpus_digest: event.purchased_corpus_digest ?? event.corpus_digest,
        effective_corpus_digest: event.effective_corpus_digest ?? event.corpus_digest,
        status: "completed",
        completed_at: event.occurred_at,
        revenue_status: revenue
          ? "recognized"
          : order?.gross_minor === 0 || order?.payment_status === "not_required"
            ? "not_applicable"
            : "pending",
        recognition_id: revenue?.recognition_id ?? null
      };
    })
    .sort((left, right) => right.completed_at.localeCompare(left.completed_at));
}

export function projectRefunds(events, filters = {}) {
  return events
    .filter((event) => isConfirmedRefundEvent(events, event))
    .filter((event) => !filters.orderId || event.order_id === filters.orderId)
    .filter((event) => !filters.creatorId || event.creator_id === filters.creatorId)
    .filter((event) => !filters.buyerId || event.buyer_id === filters.buyerId)
    .map((event) => {
      const revenueReversals = events
        .filter((candidate) => candidate.event_type === "revenue.reversed" && candidate.refund_id === event.refund_id)
        .map((candidate) => candidate.reversal_id);
      const payoutAdjustments = events
        .filter((candidate) => candidate.event_type === "payout.adjustment" && candidate.refund_id === event.refund_id)
        .map((candidate) => candidate.adjustment_id);
      return {
        refund_id: event.refund_id,
        order_id: event.order_id,
        payment_id: event.payment_id ?? null,
        buyer_id: event.buyer_id,
        creator_id: event.creator_id,
        product_id: event.product_id,
        gross_minor: event.gross_minor,
        currency: event.currency,
        reason: event.reason ?? null,
        actor_id: event.actor_id ?? null,
        provider_refund_id: event.provider_refund_id ?? null,
        provider_refund_status: event.provider_refund_status ?? (event.gross_minor === 0 ? "not_required" : null),
        revenue_reversal_ids: revenueReversals,
        payout_adjustment_ids: payoutAdjustments,
        status: "succeeded",
        occurred_at: event.occurred_at
      };
    })
    .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
}

function isConfirmedRefundEvent(events, event) {
  if (event.event_type !== "order.refunded") return false;
  const order = events.find((candidate) => (
    candidate.event_type === "order.placed" && candidate.order_id === event.order_id
  ));
  if (!order) return false;
  if (order.gross_minor === 0) return event.gross_minor === 0;
  return typeof event.provider_refund_id === "string"
    && Boolean(event.provider_refund_id)
    && event.provider_refund_status === "succeeded";
}

function isEffectiveRevocation(events, event) {
  if (event.event_type !== "entitlement.revoked") return false;
  if (event.reason !== "order_refunded") return true;
  return events.some((candidate) => (
    candidate.order_id === event.order_id && isConfirmedRefundEvent(events, candidate)
  ));
}

function pushByOrder(map, event) {
  const values = map.get(event.order_id) ?? [];
  values.push(event);
  map.set(event.order_id, values);
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

function assertMutation(type, idempotencyKey) {
  if (!EVENT_TYPES.has(type)) {
    throw new CommerceInvariantError("unknown_event_type", `Unsupported commerce event: ${type}`);
  }
  if (typeof idempotencyKey !== "string" || !idempotencyKey.trim()) {
    throw new CommerceInvariantError("idempotency_required", "Every commerce mutation requires an idempotency key");
  }
}

function assertPayloadEnvelope(payload) {
  for (const field of ["event_id", "event_type", "occurred_at", "idempotency_key", "payload_digest"]) {
    if (Object.hasOwn(payload, field)) {
      throw new CommerceInvariantError("invalid_event", `${field} is reserved for the commerce event envelope`);
    }
  }
}

function assertPersistedEnvelope(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new CommerceInvariantError("corrupt_ledger", "Persisted commerce event must be an object");
  }
  for (const field of ["event_id", "event_type", "occurred_at", "idempotency_key", "payload_digest"]) {
    if (typeof event[field] !== "string" || !event[field].trim()) {
      throw new CommerceInvariantError("corrupt_ledger", `Persisted commerce event ${field} is required`);
    }
  }
  if (Number.isNaN(new Date(event.occurred_at).getTime())) {
    throw new CommerceInvariantError("corrupt_ledger", `Invalid occurred_at for event ${event.event_id}`);
  }
}

function normalizePayload(type, payload, idempotencyKey) {
  const normalized = structuredClone(payload);
  normalized.schema_version ??= 1;
  if (type.startsWith("payment.") || type.startsWith("payout.") || type === "revenue.reversed") {
    if (normalized.currency !== undefined) normalized.currency = String(normalized.currency).toUpperCase();
  }
  if (type.startsWith("payment.")) {
    normalized.aggregate_type ??= "payment";
    normalized.aggregate_id ??= normalized.payment_id;
  }
  if (type.startsWith("payout.")) {
    normalized.aggregate_type ??= type === "payout.account_updated" ? "payout_account" : "payout";
    normalized.aggregate_id ??= normalized.payout_id ?? `${normalized.creator_id}:${normalized.currency}`;
  }
  if (type === "revenue.reversed") {
    normalized.aggregate_type ??= "revenue";
    normalized.aggregate_id ??= normalized.recognition_id;
  }
  if (type === "order.placed") {
    normalized.included_units ??= 1;
    normalized.subtotal_minor ??= normalized.gross_minor;
    normalized.discount_minor ??= 0;
    if (!Object.hasOwn(normalized, "tax_minor")) normalized.tax_minor = null;
    normalized.total_minor ??= normalized.gross_minor;
    if (normalized.gross_minor === 0) {
      normalized.payment_status = "not_required";
      normalized.payment_id = null;
    } else {
      normalized.payment_status ??= "paid";
    }
  }
  if (type === "entitlement.granted") {
    normalized.granted_units ??= 1;
    normalized.version_policy ??= "pinned";
  }
  if (idempotencyKey) normalizeAuditEnvelope(type, normalized, idempotencyKey);
  return normalized;
}

function normalizeAuditEnvelope(type, payload, idempotencyKey) {
  const aggregate = commerceAggregate(type, payload);
  payload.aggregate_type ??= aggregate.type;
  payload.aggregate_id ??= aggregate.id;
  payload.tenant_id ??= payload.creator_id ?? "platform";

  const runtimeEvent = type === "task.started" || type === "artifact.created" || type === "delivery.completed";
  const providerEvent = Boolean(payload.provider_event_id || payload.provider_refund_id || payload.provider_payout_id);
  const defaultService = runtimeEvent ? "runtime" : "commerce";
  payload.service_id ??= payload.service_name ?? defaultService;
  payload.actor_type ??= providerEvent || runtimeEvent || payload.service_name ? "service" : "account";
  payload.actor_id ??= providerEvent
    ? payload.provider
    : runtimeEvent
      ? payload.service_name ?? "runtime"
      : payload.buyer_id ?? payload.creator_id ?? payload.service_id;
  payload.request_id ??= idempotencyKey;
  payload.correlation_id ??= payload.checkout_session_id ?? payload.order_id ?? payload.request_id;
  payload.causation_id ??= payload.provider_event_id
    ?? payload.provider_refund_id
    ?? payload.reservation_id
    ?? payload.delivery_id
    ?? payload.task_id
    ?? null;
  payload.reason ??= type;
}

function commerceAggregate(type, payload) {
  if (type.startsWith("payment.")) return { type: "payment", id: payload.payment_id };
  if (type.startsWith("order.")) return { type: "order", id: payload.order_id };
  if (type.startsWith("entitlement.")) return { type: "entitlement", id: payload.entitlement_id };
  if (type.startsWith("task.")) return { type: "task", id: payload.task_id };
  if (type.startsWith("artifact.")) return { type: "artifact", id: payload.artifact_id };
  if (type.startsWith("delivery.")) return { type: "delivery", id: payload.delivery_id };
  if (type.startsWith("revenue.")) return {
    type: "revenue",
    id: payload.recognition_id ?? payload.reversal_id ?? payload.delivery_id
  };
  if (type === "payout.account_updated") return {
    type: "payout_account",
    id: `${payload.creator_id}:${payload.currency}`
  };
  if (type === "payout.adjustment") return { type: "payout_balance", id: payload.adjustment_id };
  if (type.startsWith("payout.")) return { type: "payout", id: payload.payout_id };
  return { type: type.split(".")[0], id: idempotencyKeyFallback(payload) };
}

function idempotencyKeyFallback(payload) {
  return payload.aggregate_id ?? payload.order_id ?? payload.entitlement_id ?? payload.request_id;
}

function eventPayload(event) {
  const payload = structuredClone(event);
  for (const field of ["event_id", "event_type", "occurred_at", "idempotency_key", "payload_digest"]) {
    delete payload[field];
  }
  return payload;
}

function validateEvent(event, events) {
  for (const key of ["event_id", "event_type", "occurred_at", "idempotency_key"]) {
    if (typeof event[key] !== "string" || !event[key]) {
      throw new CommerceInvariantError("invalid_event", `${key} is required`);
    }
  }
  if (event.event_type === "payment.created") {
    requireFields(event, ["payment_id", "buyer_id", "creator_id", "product_id", "currency", "provider"]);
    requirePositiveInteger(event.amount_minor, "amount_minor");
    if (event.status !== "pending") {
      throw new CommerceInvariantError("invalid_payment_status", "A Payment aggregate must start pending");
    }
    requireCurrency(event.currency);
    if (events.some((item) => item.event_type === "payment.created" && item.payment_id === event.payment_id)) {
      throw new CommerceInvariantError("payment_exists", `Payment ${event.payment_id} already exists`);
    }
  }
  if (event.event_type === "payment.status_changed") {
    requireFields(event, ["payment_id", "provider", "provider_event_id", "status"]);
    if (!PAYMENT_STATUSES.includes(event.status)) {
      throw new CommerceInvariantError("invalid_payment_status", `Unsupported payment status ${event.status}`);
    }
    const payment = requirePrior(events, "payment.created", "payment_id", event.payment_id);
    requireIdentityMatch(payment, event, ["provider"]);
    if (event.provider_occurred_at !== undefined && !Number.isFinite(Date.parse(event.provider_occurred_at))) {
      throw new CommerceInvariantError("invalid_event", "provider_occurred_at must be an ISO timestamp");
    }
    if (event.provider_sequence !== undefined) requireNonNegativeInteger(event.provider_sequence, "provider_sequence");
    if (events.some((item) => (
      item.event_type === "payment.status_changed"
      && item.provider === event.provider
      && item.provider_event_id === event.provider_event_id
    ))) {
      throw new CommerceInvariantError(
        "provider_event_already_processed",
        `Provider event ${event.provider}/${event.provider_event_id} was already processed`
      );
    }
  }
  if (event.event_type === "payment.refunded") {
    requireFields(event, ["payment_id", "refund_id", "order_id", "currency"]);
    const payment = requirePrior(events, "payment.created", "payment_id", event.payment_id);
    requireIdentityMatch(payment, event, ["currency"]);
    requirePositiveInteger(event.amount_minor, "amount_minor");
    const refundedMinor = events
      .filter((item) => item.event_type === "payment.refunded" && item.payment_id === event.payment_id)
      .reduce((sum, item) => sum + item.amount_minor, 0);
    if (refundedMinor + event.amount_minor > payment.amount_minor) {
      throw new CommerceInvariantError("refund_exceeds_payment", "Payment refunds cannot exceed the captured amount");
    }
    requirePrior(events, "order.refunded", "refund_id", event.refund_id);
  }
  if (event.event_type === "order.placed") {
    requireFields(event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency"]);
    requireNonNegativeInteger(event.gross_minor, "gross_minor");
    requireNonNegativeInteger(event.subtotal_minor, "subtotal_minor");
    requireNonNegativeInteger(event.discount_minor, "discount_minor");
    if (event.tax_minor !== null) requireNonNegativeInteger(event.tax_minor, "tax_minor");
    requireNonNegativeInteger(event.total_minor, "total_minor");
    if (event.discount_minor > event.subtotal_minor) {
      throw new CommerceInvariantError("invalid_amount", "discount_minor cannot exceed subtotal_minor");
    }
    if (event.subtotal_minor - event.discount_minor + (event.tax_minor ?? 0) !== event.total_minor
      || event.total_minor !== event.gross_minor) {
      throw new CommerceInvariantError(
        "quote_total_mismatch",
        "Order quote components must reconcile to gross_minor"
      );
    }
    requirePositiveInteger(event.included_units, "included_units");
    if (!new Set(["paid", "succeeded", "not_required"]).has(event.payment_status)) {
      throw new CommerceInvariantError("invalid_payment_status", "Confirmed orders must be succeeded or not_required");
    }
    if (event.gross_minor === 0 && (event.payment_status !== "not_required" || event.payment_id !== null)) {
      throw new CommerceInvariantError("invalid_free_payment", "A zero-value order must use payment_status=not_required without a payment id");
    }
    if (event.gross_minor > 0 && !new Set(["paid", "succeeded"]).has(event.payment_status)) {
      throw new CommerceInvariantError("payment_required", "A paid order must be paid before it can be placed");
    }
    if (event.gross_minor > 0 && event.payment_status === "succeeded") {
      const payment = projectPayment(events, event.payment_id);
      if (!payment || payment.status !== "succeeded") {
        throw new CommerceInvariantError("payment_required", "A paid checkout requires a succeeded Payment snapshot");
      }
      if (payment.refunded_minor > 0) {
        throw new CommerceInvariantError("payment_not_chargeable", "A refunded Payment cannot confirm a new order");
      }
      requireIdentityMatch(payment, event, ["buyer_id", "creator_id", "product_id", "currency"]);
      if (payment.amount_minor !== event.gross_minor) {
        throw new CommerceInvariantError("payment_amount_mismatch", "Payment amount must match the order gross amount");
      }
      if (payment.order_id && payment.order_id !== event.order_id) {
        throw new CommerceInvariantError("payment_order_mismatch", "Payment is bound to another order");
      }
      const fundedOrder = events.find((item) => (
        item.event_type === "order.placed" && item.payment_id === event.payment_id
      ));
      if (fundedOrder && fundedOrder.order_id !== event.order_id) {
        throw new CommerceInvariantError("payment_already_consumed", "Payment already funded another order");
      }
    }
    if (event.gross_minor > 0 && event.gross_minor < event.included_units) {
      throw new CommerceInvariantError("invalid_amount", "Paid order gross must allocate at least one minor unit per delivery unit");
    }
  }
  if (event.event_type === "entitlement.granted") {
    requireFields(event, ["entitlement_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    const order = requirePrior(events, "order.placed", "order_id", event.order_id);
    requireIdentityMatch(order, event, ["buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    requirePositiveInteger(event.granted_units, "granted_units");
    if (event.granted_units !== (order.included_units ?? 1)) {
      throw new CommerceInvariantError("identity_chain_mismatch", "Entitlement units must match the order snapshot");
    }
    if (events.some((item) => item.event_type === "entitlement.granted" && item.order_id === event.order_id)) {
      throw new CommerceInvariantError("entitlement_already_granted", `Order ${event.order_id} already granted an entitlement`);
    }
  }
  if (event.event_type === "entitlement.version_advanced") {
    requireFields(event, [
      "entitlement_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id",
      "from_digest", "to_digest", "from_release_id", "to_release_id", "compatibility_declaration_id"
    ]);
    if (!event.from_digest.trim() || !event.to_digest.trim()) {
      throw new CommerceInvariantError("invalid_version_digest", "Version digests must be non-empty strings");
    }
    if (event.from_digest === event.to_digest) {
      throw new CommerceInvariantError("version_unchanged", "A version advance requires a different target digest");
    }
    const grant = requirePrior(events, "entitlement.granted", "entitlement_id", event.entitlement_id);
    requireIdentityMatch(grant, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id"]);
    if ((grant.version_policy ?? "pinned") !== "track_current_compatible") {
      throw new CommerceInvariantError("version_policy_pinned", "Pinned entitlements cannot advance versions");
    }
    const current = projectEntitlement(events, event.entitlement_id);
    if (current.effective_corpus_digest !== event.from_digest) {
      throw new CommerceInvariantError(
        "version_chain_broken",
        `Version from_digest must equal current effective digest ${current.effective_corpus_digest}`
      );
    }
  }
  if (event.event_type === "entitlement.units_reserved") {
    requireFields(event, [
      "reservation_id", "entitlement_id", "order_id", "run_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"
    ]);
    requirePositiveInteger(event.units, "units");
    validateReservationLease(event);
    const entitlement = requirePrior(events, "entitlement.granted", "entitlement_id", event.entitlement_id);
    requireIdentityMatch(entitlement, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    const state = projectEntitlement(events, event.entitlement_id, { now: event.occurred_at });
    if (event.effective_corpus_digest && event.effective_corpus_digest !== state.effective_corpus_digest) {
      throw new CommerceInvariantError(
        "identity_chain_mismatch",
        "Reservation effective_corpus_digest must match the entitlement projection"
      );
    }
    if (state.status !== "active") {
      throw new CommerceInvariantError("entitlement_not_active", `Entitlement ${event.entitlement_id} is ${state.status}`);
    }
    if (state.remaining_units < event.units) {
      throw new CommerceInvariantError("insufficient_entitlement_units", `Entitlement ${event.entitlement_id} has insufficient units`);
    }
    if (events.some((item) => item.event_type === "entitlement.units_reserved" && item.reservation_id === event.reservation_id)) {
      throw new CommerceInvariantError("duplicate_reservation", `Reservation ${event.reservation_id} already exists`);
    }
  }
  if (event.event_type === "entitlement.units_consumed") {
    requireFields(event, ["reservation_id", "entitlement_id", "order_id", "delivery_id"]);
    const reservation = requirePrior(events, "entitlement.units_reserved", "reservation_id", event.reservation_id);
    requireIdentityMatch(reservation, event, ["entitlement_id", "order_id"]);
    requireReservationStatus(events, event.reservation_id, "reserved");
    requireReservationLeaseActive(reservation, event.occurred_at);
    const delivery = requirePrior(events, "delivery.completed", "delivery_id", event.delivery_id);
    requireIdentityMatch(delivery, event, ["order_id"]);
    if (delivery.entitlement_id && delivery.entitlement_id !== event.entitlement_id) {
      throw new CommerceInvariantError("identity_chain_mismatch", "Consumed entitlement must match delivery entitlement");
    }
  }
  if (event.event_type === "entitlement.units_released") {
    requireFields(event, ["reservation_id", "entitlement_id", "order_id", "reason"]);
    const reservation = requirePrior(events, "entitlement.units_reserved", "reservation_id", event.reservation_id);
    requireIdentityMatch(reservation, event, ["entitlement_id", "order_id"]);
    requireReservationStatus(events, event.reservation_id, "reserved");
  }
  if (event.event_type === "entitlement.revoked") {
    requireFields(event, ["entitlement_id", "order_id", "buyer_id", "creator_id", "agent_id", "product_id", "reason"]);
    const entitlement = requirePrior(events, "entitlement.granted", "entitlement_id", event.entitlement_id);
    requireIdentityMatch(entitlement, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id"]);
    const state = projectEntitlement(events, event.entitlement_id);
    if (state.reserved_units > 0) {
      throw new CommerceInvariantError("reservation_active", "Release active reservations before revoking an entitlement");
    }
    if (events.some((item) => item.entitlement_id === event.entitlement_id && isEffectiveRevocation(events, item))) {
      throw new CommerceInvariantError("entitlement_already_revoked", `Entitlement ${event.entitlement_id} is already revoked`);
    }
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
    if (event.reservation_id) {
      const reservation = requirePrior(events, "entitlement.units_reserved", "reservation_id", event.reservation_id);
      requireIdentityMatch(reservation, event, ["order_id", "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
      if (event.entitlement_id !== reservation.entitlement_id || event.task_id !== (reservation.task_id ?? reservation.run_id)) {
        throw new CommerceInvariantError("identity_chain_mismatch", "Delivery must match its reservation entitlement and run");
      }
      if (reservation.effective_corpus_digest
        && event.effective_corpus_digest !== reservation.effective_corpus_digest) {
        throw new CommerceInvariantError(
          "identity_chain_mismatch",
          "Delivery effective_corpus_digest must match the reserved version"
        );
      }
      requireReservationStatus(events, event.reservation_id, "reserved");
      requireReservationLeaseActive(reservation, event.occurred_at);
    }
    if (events.some((item) => item.event_type === "delivery.completed" && item.task_id === event.task_id)) {
      throw new CommerceInvariantError("task_already_delivered", `Task ${event.task_id} already has a Delivery`);
    }
  }
  if (event.event_type === "revenue.recognized") {
    requireFields(event, ["recognition_id", "delivery_id", "order_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency"]);
    const delivery = requirePrior(events, "delivery.completed", "delivery_id", event.delivery_id);
    requireIdentityMatch(delivery, event, ["order_id", "creator_id", "agent_id", "product_id", "corpus_digest"]);
    requirePositiveInteger(event.gross_minor, "gross_minor");
    const order = requirePrior(events, "order.placed", "order_id", event.order_id);
    if (!new Set(["paid", "succeeded"]).has(order.payment_status ?? "paid") || order.gross_minor === 0) {
      throw new CommerceInvariantError("revenue_not_applicable", "Free or unpaid orders do not recognize revenue");
    }
    requireNonNegativeInteger(event.creator_share_minor, "creator_share_minor");
    requireNonNegativeInteger(event.hatch_share_minor, "hatch_share_minor");
    if (event.creator_share_minor + event.hatch_share_minor !== event.gross_minor) {
      throw new CommerceInvariantError("invalid_split", "Creator and Hatch shares must equal gross revenue");
    }
    if (events.some((item) => item.event_type === "revenue.recognized" && item.delivery_id === event.delivery_id)) {
      throw new CommerceInvariantError("revenue_already_recognized", `Delivery ${event.delivery_id} already recognized revenue`);
    }
    const recognizedMinor = events
      .filter((item) => item.event_type === "revenue.recognized" && item.order_id === event.order_id)
      .reduce((sum, item) => sum + item.gross_minor, 0);
    if (recognizedMinor + event.gross_minor > order.gross_minor) {
      throw new CommerceInvariantError("revenue_exceeds_order", "Recognized revenue cannot exceed the order gross amount");
    }
  }
  if (event.event_type === "revenue.reversed") {
    requireFields(event, [
      "reversal_id", "recognition_id", "refund_id", "delivery_id", "order_id", "creator_id", "currency"
    ]);
    const recognition = requirePrior(events, "revenue.recognized", "recognition_id", event.recognition_id);
    requireIdentityMatch(recognition, event, ["delivery_id", "order_id", "creator_id", "currency"]);
    requirePrior(events, "order.refunded", "refund_id", event.refund_id);
    requirePositiveInteger(event.gross_minor, "gross_minor");
    requireNonNegativeInteger(event.creator_share_minor, "creator_share_minor");
    requireNonNegativeInteger(event.hatch_share_minor, "hatch_share_minor");
    for (const field of ["gross_minor", "creator_share_minor", "hatch_share_minor"]) {
      if (event[field] !== recognition[field]) {
        throw new CommerceInvariantError("invalid_revenue_reversal", `Revenue reversal ${field} must match recognition`);
      }
    }
    if (events.some((item) => (
      item.event_type === "revenue.reversed" && item.recognition_id === event.recognition_id
    ))) {
      throw new CommerceInvariantError(
        "revenue_already_reversed",
        `Recognition ${event.recognition_id} was already reversed`
      );
    }
  }
  if (event.event_type === "order.refunded") {
    requireFields(event, ["refund_id", "order_id", "buyer_id", "creator_id", "product_id", "currency"]);
    const order = requirePrior(events, "order.placed", "order_id", event.order_id);
    requireIdentityMatch(order, event, ["buyer_id", "creator_id", "product_id", "currency"]);
    requireNonNegativeInteger(event.gross_minor, "gross_minor");
    if (order.gross_minor === 0) {
      if (event.gross_minor !== 0) {
        throw new CommerceInvariantError("refund_exceeds_order", "A free order cancellation must have a zero refund amount");
      }
      if (events.some((item) => item.order_id === event.order_id && isConfirmedRefundEvent(events, item))) {
        throw new CommerceInvariantError("order_already_cancelled", `Free order ${event.order_id} was already cancelled`);
      }
    } else {
      requirePositiveInteger(event.gross_minor, "gross_minor");
      if (typeof event.provider_refund_id !== "string" || !event.provider_refund_id) {
        throw new CommerceInvariantError(
          "provider_refund_confirmation_required",
          "A paid refund requires a provider_refund_id"
        );
      }
      if (event.provider_refund_status !== "succeeded") {
        throw new CommerceInvariantError(
          "provider_refund_not_confirmed",
          "A paid order can only be refunded after the provider confirms success"
        );
      }
      const duplicateProviderRefund = events.find((item) => (
        isConfirmedRefundEvent(events, item)
        && item.provider_refund_id === event.provider_refund_id
      ));
      if (duplicateProviderRefund) {
        throw new CommerceInvariantError(
          "provider_refund_already_processed",
          `Provider refund ${event.provider_refund_id} was already processed`
        );
      }
    }
    const refundedMinor = events
      .filter((item) => item.order_id === event.order_id && isConfirmedRefundEvent(events, item))
      .reduce((sum, item) => sum + item.gross_minor, 0);
    if (refundedMinor + event.gross_minor > order.gross_minor) {
      throw new CommerceInvariantError("refund_exceeds_order", "Refund total cannot exceed the order gross amount");
    }
  }
  if (event.event_type === "payout.adjustment") {
    requireFields(event, [
      "adjustment_id", "creator_id", "currency", "reason", "source_type", "source_id", "order_id", "refund_id"
    ]);
    requireInteger(event.amount_minor, "amount_minor");
    if (event.amount_minor >= 0) {
      throw new CommerceInvariantError("invalid_adjustment", "Refund payout adjustments must be negative");
    }
    if (event.source_type !== "revenue_reversal") {
      throw new CommerceInvariantError("invalid_adjustment", "Payout adjustment source_type must be revenue_reversal");
    }
    const reversal = requirePrior(events, "revenue.reversed", "reversal_id", event.source_id);
    requireIdentityMatch(reversal, event, ["creator_id", "currency", "order_id", "refund_id"]);
    if (event.amount_minor !== -reversal.creator_share_minor) {
      throw new CommerceInvariantError("invalid_adjustment", "Payout adjustment must negate the creator revenue share");
    }
    if (events.some((item) => item.event_type === "payout.adjustment" && item.source_id === event.source_id)) {
      throw new CommerceInvariantError("adjustment_exists", `Adjustment for ${event.source_id} already exists`);
    }
  }
  if (event.event_type === "payout.account_updated") {
    requireFields(event, ["creator_id", "currency", "provider", "status"]);
    if (!new Set(["not_connected", "onboarding_incomplete", "under_review", "active", "restricted"]).has(event.status)) {
      throw new CommerceInvariantError("invalid_payout_account_status", `Unsupported payout account status ${event.status}`);
    }
    requireCurrency(event.currency);
  }
  if (event.event_type === "payout.reserved") {
    requireFields(event, ["payout_id", "batch_id", "creator_id", "currency", "provider"]);
    requirePositiveInteger(event.amount_minor, "amount_minor");
    requireCurrency(event.currency);
    if (events.some((item) => item.event_type === "payout.reserved" && item.payout_id === event.payout_id)) {
      throw new CommerceInvariantError("payout_exists", `Payout ${event.payout_id} already exists`);
    }
    if (events.some((item) => (
      item.event_type === "payout.reserved"
      && item.creator_id === event.creator_id
      && item.currency === event.currency
      && item.batch_id === event.batch_id
    ))) {
      throw new CommerceInvariantError("payout_batch_exists", `Payout batch ${event.batch_id} already exists`);
    }
    const account = events.findLast((item) => (
      item.event_type === "payout.account_updated"
      && item.creator_id === event.creator_id
      && item.currency === event.currency
    ));
    if (!account || account.status !== "active") {
      throw new CommerceInvariantError("payout_account_not_active", "Creator payout account must be active");
    }
    const balance = projectPayoutBalance(events, event.creator_id, event.currency);
    if (balance.available_minor < event.amount_minor) {
      throw new CommerceInvariantError("insufficient_payout_balance", "Available balance is lower than payout amount");
    }
  }
  if (event.event_type === "payout.submitted") {
    requireFields(event, ["payout_id", "provider", "provider_payout_id"]);
    const payout = projectPayout(events, event.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${event.payout_id} was not found`);
    if (payout.status !== "reserved") {
      throw new CommerceInvariantError("invalid_payout_transition", `Payout ${event.payout_id} is ${payout.status}`);
    }
    if (payout.provider !== event.provider) {
      throw new CommerceInvariantError("identity_chain_mismatch", "Payout provider must match its reservation");
    }
  }
  if (new Set(["payout.in_transit", "payout.paid", "payout.failed"]).has(event.event_type)) {
    requireFields(event, ["payout_id", "provider", "provider_event_id", "provider_payout_id"]);
    const payout = projectPayout(events, event.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${event.payout_id} was not found`);
    if (payout.provider !== event.provider) {
      throw new CommerceInvariantError("identity_chain_mismatch", "Payout provider must match its reservation");
    }
    const submitted = events.find((item) => (
      item.event_type === "payout.submitted"
      && item.payout_id === event.payout_id
      && item.provider_payout_id === event.provider_payout_id
    ));
    if (!submitted) {
      throw new CommerceInvariantError("provider_payout_not_found", "Provider payout must have been submitted first");
    }
    if (events.some((item) => (
      new Set(["payout.in_transit", "payout.paid", "payout.failed"]).has(item.event_type)
      && item.provider === event.provider
      && item.provider_event_id === event.provider_event_id
    ))) {
      throw new CommerceInvariantError(
        "provider_event_already_processed",
        `Provider event ${event.provider}/${event.provider_event_id} was already processed`
      );
    }
  }
  if (event.event_type === "payout.reconciliation_failed") {
    requireFields(event, ["payout_id", "provider", "provider_payout_id", "failure_code"]);
    const payout = projectPayout(events, event.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${event.payout_id} was not found`);
    if (!new Set(["submitted", "in_transit"]).has(payout.status)) {
      throw new CommerceInvariantError("invalid_payout_transition", "Only pending payouts can record reconciliation failures");
    }
    if (payout.provider !== event.provider || payout.provider_payout_id !== event.provider_payout_id) {
      throw new CommerceInvariantError("identity_chain_mismatch", "Payout reconciliation must match the active provider attempt");
    }
  }
  if (event.event_type === "payout.retried") {
    requireFields(event, ["payout_id", "reason"]);
    const payout = projectPayout(events, event.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${event.payout_id} was not found`);
    if (payout.status !== "failed") {
      throw new CommerceInvariantError("invalid_payout_transition", "Only failed payouts can be retried");
    }
    const balance = projectPayoutBalance(events, payout.creator_id, payout.currency);
    if (balance.available_minor < payout.amount_minor) {
      throw new CommerceInvariantError("insufficient_payout_balance", "Available balance is lower than retry amount");
    }
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

function requireInteger(value, field) {
  if (!Number.isSafeInteger(value)) {
    throw new CommerceInvariantError("invalid_amount", `${field} must be an integer`);
  }
}

function requireCurrency(value) {
  if (!/^[A-Z]{3}$/.test(value)) {
    throw new CommerceInvariantError("invalid_currency", "Currency must be a three-letter ISO code");
  }
}

function validateReservationLease(event) {
  if (event.expires_at !== undefined && event.lease_ttl_ms !== undefined) {
    throw new CommerceInvariantError(
      "invalid_reservation_lease",
      "A reservation must use expires_at or lease_ttl_ms, not both"
    );
  }
  if (event.lease_ttl_ms !== undefined) {
    if (!Number.isSafeInteger(event.lease_ttl_ms) || event.lease_ttl_ms <= 0) {
      throw new CommerceInvariantError("invalid_reservation_lease", "lease_ttl_ms must be a positive integer");
    }
  }
  if (event.expires_at !== undefined) {
    const expiresAt = Date.parse(event.expires_at);
    const reservedAt = Date.parse(event.occurred_at);
    if (typeof event.expires_at !== "string" || !Number.isFinite(expiresAt) || expiresAt <= reservedAt) {
      throw new CommerceInvariantError(
        "invalid_reservation_lease",
        "expires_at must be a valid timestamp after the reservation time"
      );
    }
  }
}

function reservationExpiresAt(reservation) {
  if (typeof reservation.expires_at === "string" && Number.isFinite(Date.parse(reservation.expires_at))) {
    return new Date(reservation.expires_at).toISOString();
  }
  if (Number.isSafeInteger(reservation.lease_ttl_ms) && reservation.lease_ttl_ms > 0) {
    const reservedAt = Date.parse(reservation.occurred_at);
    if (Number.isFinite(reservedAt)) return new Date(reservedAt + reservation.lease_ttl_ms).toISOString();
  }
  return null;
}

function projectionTimestamp(options) {
  const value = options instanceof Date || typeof options === "string" || typeof options === "number"
    ? options
    : options?.now;
  if (value === undefined) return Date.now();
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new CommerceInvariantError("invalid_projection_time", "Projection now must be a valid timestamp");
  }
  return timestamp;
}

function requireReservationLeaseActive(reservation, now) {
  const expiresAt = reservationExpiresAt(reservation);
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(now)) {
    throw new CommerceInvariantError(
      "reservation_expired",
      `Reservation ${reservation.reservation_id} expired at ${expiresAt}`
    );
  }
}

function requireReservationStatus(events, reservationId, expected) {
  const transitions = events.filter((event) => (
    event.reservation_id === reservationId && (
      event.event_type === "entitlement.units_reserved" ||
      event.event_type === "entitlement.units_consumed" ||
      event.event_type === "entitlement.units_released"
    )
  ));
  let status;
  for (const event of transitions) {
    if (event.event_type === "entitlement.units_reserved") status = "reserved";
    if (event.event_type === "entitlement.units_consumed") status = "consumed";
    if (event.event_type === "entitlement.units_released") status = "released";
  }
  if (status !== expected) {
    throw new CommerceInvariantError(
      "reservation_not_active",
      `Reservation ${reservationId} is ${status ?? "missing"}; expected ${expected}`
    );
  }
}

async function readEvents(filePath) {
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return parseEvents(content);
}

function parseEvents(content) {
  const events = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new CommerceInvariantError("corrupt_ledger", `Commerce ledger contains invalid JSON: ${error.message}`);
    }
  }
  return events;
}

async function persistEventsAtomically(filePath, events) {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(directory, { recursive: true });
  const content = events.length > 0
    ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
    : "";
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, filePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function acquireFileLock(filePath, options) {
  const lockPath = `${filePath}.lock`;
  const startedAt = Date.now();
  await mkdir(path.dirname(filePath), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() }), "utf8");
      return async () => {
        await handle.close().catch(() => {});
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const lockAge = await stat(lockPath)
        .then((value) => Date.now() - value.mtimeMs)
        .catch(() => 0);
      if (lockAge > options.staleLockMs) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() - startedAt >= options.timeoutMs) {
        throw new CommerceInvariantError("ledger_busy", "Timed out waiting for the commerce transaction lock");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}
