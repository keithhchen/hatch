import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CommerceInvariantError,
  CommerceLedger,
  CommerceService,
  LedgerCommerceSink,
  projectCreatorDashboard
} from "./index.js";

const identity = {
  buyer_id: "buyer_v2",
  buyer_display_name: "Buyer V2",
  creator_id: "creator_v2",
  agent_id: "agent_v2",
  product_id: "product_v2",
  product_name: "Product V2",
  corpus_digest: `sha256:${"d".repeat(64)}`,
  release_id: "release_v2",
  currency: "USD"
};

test("file-backed ledgers re-read the source and serialize independent writers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-v2-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const first = await CommerceLedger.open({ filePath });
  const second = await CommerceLedger.open({ filePath });

  await Promise.all([
    first.append("order.placed", {
      ...identity,
      order_id: "order_cross_1",
      gross_minor: 0
    }, { idempotencyKey: "cross:1" }),
    second.append("order.placed", {
      ...identity,
      order_id: "order_cross_2",
      gross_minor: 0
    }, { idempotencyKey: "cross:2" })
  ]);

  assert.deepEqual(
    first.listEvents().map((event) => event.order_id).sort(),
    ["order_cross_1", "order_cross_2"]
  );
  assert.equal(second.listEvents().length, 2);
});

test("appendMany rolls back the whole transaction when a later invariant fails", async () => {
  const ledger = await CommerceLedger.open();
  await assert.rejects(
    ledger.appendMany([
      {
        type: "order.placed",
        payload: { ...identity, order_id: "order_atomic", gross_minor: 0 },
        idempotencyKey: "atomic:order"
      },
      {
        type: "entitlement.granted",
        payload: {
          ...identity,
          buyer_id: "wrong_buyer",
          order_id: "order_atomic",
          entitlement_id: "entitlement_atomic"
        },
        idempotencyKey: "atomic:entitlement"
      }
    ]),
    (error) => error.code === "identity_chain_mismatch"
  );
  assert.equal(ledger.listEvents().length, 0);
});

test("free checkout atomically creates one real order and permanent entitlement", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const command = {
    ...identity,
    gross_minor: 0,
    idempotency_key: "checkout:free:1"
  };
  const first = await commerce.confirmCheckout(command);
  const replay = await commerce.confirmCheckout(command);

  assert.equal(first.order.order_id, replay.order.order_id);
  assert.equal(first.order.payment_status, "not_required");
  assert.equal(first.order.payment_id, null);
  assert.equal(first.entitlement.status, "active");
  assert.equal(first.order.order_line_id, first.entitlement.order_line_id);
  assert.equal(first.entitlement.valid_from, first.entitlement.granted_at);
  assert.equal(first.entitlement.valid_until, null);
  assert.equal(first.order.access_mode, "unmetered");
  assert.equal(first.entitlement.access_mode, "unmetered");
  assert.equal(Object.hasOwn(first.entitlement, "remaining_units"), false);
  assert.equal(ledger.listEvents().length, 2);

  await assert.rejects(
    commerce.confirmCheckout({ ...command, product_id: "different_product" }),
    (error) => error instanceof CommerceInvariantError && error.code === "idempotency_conflict"
  );
});

test("a free purchase stays usable after repeated runs and never creates delivery accounting", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const purchase = await commerce.confirmCheckout({
    ...identity,
    product_id: "product_free_unlimited",
    gross_minor: 0,
    idempotency_key: "checkout:free:unlimited"
  });
  assert.equal(purchase.entitlement.access_mode, "unmetered");
  assert.equal(purchase.entitlement.status, "active");
  assert.deepEqual(purchase.entitlement.reservations, []);
  assert.deepEqual(commerce.getEntitlement(purchase.entitlement.entitlement_id).reservations, []);
  await assert.rejects(
    commerce.authorizeAndReserve({
      entitlement_id: purchase.entitlement.entitlement_id,
      run_id: "run_free_should_not_reserve",
      idempotency_key: "reserve:free:should-not-reserve"
    }),
    (error) => error.code === "access_unmetered"
  );
  assert.equal(ledger.listEvents().filter((event) => event.event_type.startsWith("delivery.") || event.event_type.includes("units_")).length, 0);
});

test("metered access still supports the future reservation path", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 100,
    payment_status: "paid",
    payment_id: "pay:metered:delivery",
    idempotency_key: "checkout:metered:delivery"
  });
  const entitlementId = checkout.entitlement.entitlement_id;
  const firstReservation = await commerce.authorizeAndReserve({
    entitlement_id: entitlementId,
    run_id: "task_released",
    idempotency_key: "reserve:released"
  });
  assert.equal(firstReservation.entitlement.remaining_units, 0);

  await assert.rejects(
    commerce.authorizeAndReserve({
      entitlement_id: entitlementId,
      run_id: "task_too_early",
      idempotency_key: "reserve:too-early"
    }),
    (error) => error.code === "insufficient_entitlement_units"
  );

  await commerce.releaseReservation({
    reservation_id: firstReservation.reservation.reservation_id,
    reason: "run_failed",
    idempotency_key: "release:first"
  });
  assert.equal(commerce.getEntitlement(entitlementId).remaining_units, 1);

  const reservation = await commerce.authorizeAndReserve({
    entitlement_id: entitlementId,
    run_id: "task_delivered",
    idempotency_key: "reserve:delivered"
  });
  await appendTaskAndArtifact(ledger, checkout, {
    taskId: "task_delivered",
    artifactId: "artifact_delivered"
  });
  const completed = await commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    artifact_id: "artifact_delivered",
    delivery_id: "delivery_free",
    idempotency_key: "delivery:free"
  });
  const replay = await commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    artifact_id: "artifact_delivered",
    delivery_id: "delivery_free",
    idempotency_key: "delivery:free"
  });

  assert.equal(completed.entitlement.status, "consumed");
  assert.equal(completed.entitlement.consumed_units, 1);
  assert.equal(completed.revenue.gross_minor, 100);
  assert.equal(completed.revenue_status, "recognized");
  assert.equal(replay.delivery.delivery_id, "delivery_free");
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "delivery.completed").length, 1);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "revenue.recognized").length, 1);
});

test("paid delivery recognizes revenue and a full refund revokes further authorization", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 3999,
    subtotal_minor: 4099,
    discount_minor: 200,
    tax_minor: 100,
    total_minor: 3999,
    payment_status: "paid",
    payment_id: "pay_v2",
    idempotency_key: "checkout:paid:1"
  });
  assert.deepEqual(
    {
      subtotal_minor: checkout.order.subtotal_minor,
      discount_minor: checkout.order.discount_minor,
      tax_minor: checkout.order.tax_minor,
      total_minor: checkout.order.total_minor,
      gross_minor: checkout.order.gross_minor
    },
    { subtotal_minor: 4099, discount_minor: 200, tax_minor: 100, total_minor: 3999, gross_minor: 3999 }
  );
  await assert.rejects(
    commerce.confirmCheckout({
      ...identity,
      gross_minor: 3999,
      subtotal_minor: 3999,
      discount_minor: 100,
      tax_minor: null,
      total_minor: 3999,
      payment_status: "paid",
      payment_id: "pay_bad_quote",
      idempotency_key: "checkout:paid:bad-quote"
    }),
    (error) => error.code === "quote_total_mismatch"
  );
  const reservation = await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "task_paid",
    idempotency_key: "reserve:paid"
  });
  await appendTaskAndArtifact(ledger, checkout, {
    taskId: "task_paid",
    artifactId: "artifact_paid"
  });
  const completed = await commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    artifact_id: "artifact_paid",
    delivery_id: "delivery_paid",
    idempotency_key: "delivery:paid"
  });

  assert.equal(completed.revenue_status, "recognized");
  assert.equal(completed.revenue.creator_share_minor, 3600);
  assert.equal(completed.revenue.hatch_share_minor, 399);
  assert.equal(completed.delivery.revenue_status, "recognized");

  const refunded = await commerce.refundOrder({
    order_id: checkout.order.order_id,
    reason: "buyer_request",
    provider_refund_id: "provider_refund_paid_v2",
    provider_refund_status: "succeeded",
    idempotency_key: "refund:paid"
  });
  const replay = await commerce.refundOrder({
    order_id: checkout.order.order_id,
    reason: "buyer_request",
    provider_refund_id: "provider_refund_paid_v2",
    provider_refund_status: "succeeded",
    idempotency_key: "refund:paid"
  });
  assert.equal(refunded.status, "refunded");
  assert.equal(refunded.entitlement.status, "revoked");
  assert.equal(refunded.refunds.length, 1);
  assert.equal(refunded.refunds[0].provider_refund_id, "provider_refund_paid_v2");
  assert.equal(refunded.refunds[0].provider_refund_status, "succeeded");
  assert.equal(replay.refunds.length, 1);
  assert.equal(projectCreatorDashboard(ledger.listEvents(), identity.creator_id).metrics.creator_share_minor, 0);

  await assert.rejects(
    commerce.authorizeAndReserve({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: "task_after_refund",
      idempotency_key: "reserve:after-refund"
    }),
    (error) => error.code === "entitlement_not_active"
  );
});

test("a delivery with pending revenue is reconciled without replaying the delivery", async () => {
  const ledger = await CommerceLedger.open();
  const durableRevenue = new LedgerCommerceSink(ledger);
  let failRecognition = true;
  const commerce = new CommerceService(ledger, {
    revenueSink: {
      async recognizeDelivery(delivery) {
        if (failRecognition) {
          failRecognition = false;
          throw new CommerceInvariantError("finance_temporarily_unavailable", "temporary finance outage");
        }
        return durableRevenue.recognizeDelivery(delivery);
      }
    }
  });
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 3999,
    payment_status: "paid",
    payment_id: "pay_revenue_reconcile",
    idempotency_key: "checkout:paid:revenue-reconcile"
  });
  const reservation = await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "task_revenue_reconcile",
    idempotency_key: "reserve:revenue-reconcile"
  });
  await appendTaskAndArtifact(ledger, checkout, {
    taskId: "task_revenue_reconcile",
    artifactId: "artifact_revenue_reconcile"
  });
  const delivered = await commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    artifact_id: "artifact_revenue_reconcile",
    delivery_id: "delivery_revenue_reconcile",
    idempotency_key: "delivery:revenue-reconcile"
  });
  assert.equal(delivered.revenue_status, "pending");
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "delivery.completed").length, 1);

  const reconciled = await commerce.reconcilePendingRevenue();
  assert.equal(reconciled.checked_count, 1);
  assert.equal(reconciled.recognized_count, 1);
  assert.equal(reconciled.pending_count, 0);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "revenue.recognized").length, 1);
  assert.equal((await commerce.reconcilePendingRevenue()).checked_count, 0);
});

test("reservation leases expire in projection and a new reserve reconciles the abandoned unit", async () => {
  let now = new Date("2026-08-12T08:00:00.000Z");
  const clock = () => new Date(now);
  const ledger = await CommerceLedger.open({ clock });
  const commerce = new CommerceService(ledger, { clock, reservationTtlMs: 60_000 });
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 100,
    payment_status: "paid",
    payment_id: "pay:lease:auto",
    idempotency_key: "checkout:lease:auto"
  });
  const first = await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_abandoned",
    ttl: 1_000,
    idempotency_key: "reserve:lease:abandoned"
  });

  assert.equal(first.reservation.status, "reserved");
  assert.equal(first.reservation.expires_at, "2026-08-12T08:00:01.000Z");
  assert.equal(first.entitlement.remaining_units, 0);

  now = new Date("2026-08-12T08:00:01.000Z");
  const expired = commerce.getEntitlement(checkout.entitlement.entitlement_id);
  assert.equal(expired.reservations[0].status, "expired");
  assert.equal(expired.reserved_units, 0);
  assert.equal(expired.remaining_units, 1);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.units_released").length, 0);

  const second = await commerce.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_after_crash",
    ttl_ms: 30_000,
    idempotency_key: "reserve:lease:after-crash"
  });
  assert.equal(second.reservation.status, "reserved");
  assert.equal(second.entitlement.remaining_units, 0);
  const releases = ledger.listEvents().filter((event) => event.event_type === "entitlement.units_released");
  assert.equal(releases.length, 1);
  assert.equal(releases[0].reservation_id, first.reservation.reservation_id);
  assert.equal(releases[0].reason, "reservation_expired");

  const replay = await commerce.reconcileExpiredReservations(now);
  assert.equal(replay.released_count, 0);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.units_released").length, 1);
});

test("entitlement valid_until expires unused access and authorization fails closed", async () => {
  let now = new Date("2026-08-12T08:30:00.000Z");
  const clock = () => new Date(now);
  const ledger = await CommerceLedger.open({ clock });
  const commerce = new CommerceService(ledger, { clock });
  const checkout = await commerce.confirmCheckout({
    ...identity,
    product_id: "product_expiring_access",
    gross_minor: 0,
    valid_until: "2026-08-12T08:31:00.000Z",
    idempotency_key: "checkout:free:expiring-access"
  });
  assert.equal(checkout.entitlement.status, "active");
  assert.equal(checkout.entitlement.valid_until, "2026-08-12T08:31:00.000Z");

  now = new Date("2026-08-12T08:31:00.000Z");
  assert.equal(commerce.getEntitlement(checkout.entitlement.entitlement_id).status, "expired");
  await assert.rejects(
    commerce.authorizeAndReserve({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: "run_after_access_expiry",
      idempotency_key: "reserve:after-access-expiry"
    }),
    (error) => error.code === "entitlement_not_active"
  );
});

test("explicit reservation expiry is idempotent and cannot be consumed after the lease", async () => {
  let now = new Date("2026-08-12T09:00:00.000Z");
  const clock = () => new Date(now);
  const ledger = await CommerceLedger.open({ clock });
  const commerce = new CommerceService(ledger, { clock });
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 100,
    payment_status: "paid",
    payment_id: "pay:lease:explicit",
    idempotency_key: "checkout:lease:explicit"
  });
  const command = {
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_explicit_expiry",
    expires_at: "2026-08-12T09:01:00.000Z",
    idempotency_key: "reserve:lease:explicit"
  };
  const first = await commerce.authorizeAndReserve(command);
  const replay = await commerce.authorizeAndReserve(command);
  assert.equal(first.reservation.reservation_id, replay.reservation.reservation_id);
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.units_reserved").length, 1);

  await appendTaskAndArtifact(ledger, checkout, {
    taskId: "run_explicit_expiry",
    artifactId: "artifact_expired_lease"
  });
  now = new Date("2026-08-12T09:01:00.000Z");
  await assert.rejects(
    commerce.completeDelivery({
      reservation_id: first.reservation.reservation_id,
      artifact_id: "artifact_expired_lease",
      delivery_id: "delivery_expired_lease",
      idempotency_key: "delivery:expired-lease"
    }),
    (error) => error.code === "reservation_expired"
  );
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "delivery.completed").length, 0);
});

test("reservation lease commands reject ambiguous or already-expired deadlines", async () => {
  const now = new Date("2026-08-12T09:30:00.000Z");
  const clock = () => new Date(now);
  const ledger = await CommerceLedger.open({ clock });
  const commerce = new CommerceService(ledger, { clock });
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 100,
    payment_status: "paid",
    payment_id: "pay:lease:invalid",
    idempotency_key: "checkout:lease:invalid"
  });
  const base = {
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_invalid_lease"
  };

  await assert.rejects(
    commerce.authorizeAndReserve({
      ...base,
      ttl: 1_000,
      expires_at: "2026-08-12T09:31:00.000Z",
      idempotency_key: "reserve:lease:ambiguous"
    }),
    (error) => error.code === "invalid_reservation_lease"
  );
  await assert.rejects(
    commerce.authorizeAndReserve({
      ...base,
      expires_at: "2026-08-12T09:30:00.000Z",
      idempotency_key: "reserve:lease:past"
    }),
    (error) => error.code === "invalid_reservation_lease"
  );
  await assert.rejects(
    commerce.authorizeAndReserve({
      ...base,
      ttl: 0,
      idempotency_key: "reserve:lease:zero"
    }),
    (error) => error.code === "invalid_command"
  );
  assert.equal(ledger.listEvents().filter((event) => event.event_type === "entitlement.units_reserved").length, 0);
});

test("file-backed reconcilers release one expired reservation exactly once", async () => {
  let now = new Date("2026-08-12T10:00:00.000Z");
  const clock = () => new Date(now);
  const directory = await mkdtemp(path.join(os.tmpdir(), "hatch-commerce-reconcile-"));
  const filePath = path.join(directory, "ledger.jsonl");
  const firstLedger = await CommerceLedger.open({ filePath, clock });
  const secondLedger = await CommerceLedger.open({ filePath, clock });
  const first = new CommerceService(firstLedger, { clock });
  const second = new CommerceService(secondLedger, { clock });
  const checkout = await first.confirmCheckout({
    ...identity,
    gross_minor: 100,
    payment_status: "paid",
    payment_id: "pay:lease:cross-instance",
    idempotency_key: "checkout:lease:cross-instance"
  });
  await first.authorizeAndReserve({
    entitlement_id: checkout.entitlement.entitlement_id,
    run_id: "run_cross_instance_abandoned",
    ttl: 1_000,
    idempotency_key: "reserve:lease:cross-instance"
  });
  now = new Date("2026-08-12T10:00:02.000Z");

  await Promise.all([
    first.reconcileExpiredReservations(now),
    second.reconcileExpiredReservations(now)
  ]);
  assert.equal(firstLedger.listEvents().filter((event) => event.event_type === "entitlement.units_released").length, 1);
  assert.equal(first.getEntitlement(checkout.entitlement.entitlement_id).remaining_units, 1);
});

test("paid refunds fail closed without provider confirmation and free orders remain cancellable", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const paid = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 3999,
    payment_status: "paid",
    payment_id: "pay_fail_closed",
    idempotency_key: "checkout:paid:fail-closed"
  });

  await assert.rejects(
    commerce.refundOrder({
      order_id: paid.order.order_id,
      reason: "buyer_request",
      idempotency_key: "refund:paid:missing-provider"
    }),
    (error) => error.code === "provider_refund_confirmation_required"
  );
  await assert.rejects(
    commerce.refundOrder({
      order_id: paid.order.order_id,
      reason: "buyer_request",
      provider_refund_id: "provider_refund_pending",
      provider_refund_status: "pending",
      idempotency_key: "refund:paid:pending-provider"
    }),
    (error) => error.code === "provider_refund_not_confirmed"
  );
  assert.equal(commerce.getOrder(paid.order.order_id).status, "fulfilled");
  assert.equal(ledger.listEvents().some((event) => event.event_type === "order.refunded"), false);
  assert.equal(ledger.listEvents().some((event) => event.event_type === "entitlement.revoked"), false);

  const free = await commerce.confirmCheckout({
    ...identity,
    product_id: "product_free_cancel",
    gross_minor: 0,
    idempotency_key: "checkout:free:cancel"
  });
  const cancelled = await commerce.refundOrder({
    order_id: free.order.order_id,
    reason: "buyer_request",
    idempotency_key: "refund:free:cancel"
  });
  const replay = await commerce.refundOrder({
    order_id: free.order.order_id,
    reason: "buyer_request",
    idempotency_key: "refund:free:cancel"
  });

  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.entitlement.status, "revoked");
  assert.equal(cancelled.refunds[0].gross_minor, 0);
  assert.equal(cancelled.refunds[0].provider_refund_status, "not_required");
  assert.equal(replay.refunds.length, 1);
  assert.deepEqual(commerce.getEntitlement(free.entitlement.entitlement_id).reservations, []);
});

test("multi-unit paid orders recognize each delivery once without exceeding order gross", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const checkout = await commerce.confirmCheckout({
    ...identity,
    gross_minor: 3999,
    included_units: 2,
    payment_status: "paid",
    payment_id: "pay_two_units",
    idempotency_key: "checkout:paid:two-units"
  });
  const reservations = [];
  for (const suffix of ["a", "b"]) {
    reservations.push(await commerce.authorizeAndReserve({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: `task_two_${suffix}`,
      idempotency_key: `reserve:two:${suffix}`
    }));
    await appendTaskAndArtifact(ledger, checkout, {
      taskId: `task_two_${suffix}`,
      artifactId: `artifact_two_${suffix}`
    });
  }

  const completed = await Promise.all(reservations.map((reservation, index) => commerce.completeDelivery({
    reservation_id: reservation.reservation.reservation_id,
    artifact_id: `artifact_two_${index === 0 ? "a" : "b"}`,
    delivery_id: `delivery_two_${index === 0 ? "a" : "b"}`,
    idempotency_key: `delivery:two:${index}`
  })));
  const recognizedGross = completed.reduce((sum, result) => sum + result.revenue.gross_minor, 0);
  const dashboard = projectCreatorDashboard(ledger.listEvents(), identity.creator_id);

  assert.equal(recognizedGross, 3999);
  assert.equal(dashboard.metrics.successful_deliveries, 2);
  assert.equal(dashboard.metrics.creator_share_minor + dashboard.metrics.hatch_share_minor, 3999);
  assert.equal(dashboard.orders[0].delivery_count, 2);
});

test("two independent paid orders for one Buyer recognize only their own delivery units", async () => {
  const ledger = await CommerceLedger.open();
  const commerce = new CommerceService(ledger);
  const purchases = [];

  for (const [suffix, grossMinor] of [["first", 1200], ["second", 1800]]) {
    const checkout = await commerce.confirmCheckout({
      ...identity,
      gross_minor: grossMinor,
      included_units: 1,
      payment_status: "paid",
      payment_id: `pay_two_orders_${suffix}`,
      idempotency_key: `checkout:paid:two-orders:${suffix}`
    });
    const reservation = await commerce.authorizeAndReserve({
      entitlement_id: checkout.entitlement.entitlement_id,
      run_id: `task_two_orders_${suffix}`,
      idempotency_key: `reserve:two-orders:${suffix}`
    });
    await appendTaskAndArtifact(ledger, checkout, {
      taskId: `task_two_orders_${suffix}`,
      artifactId: `artifact_two_orders_${suffix}`
    });
    const completed = await commerce.completeDelivery({
      reservation_id: reservation.reservation.reservation_id,
      artifact_id: `artifact_two_orders_${suffix}`,
      delivery_id: `delivery_two_orders_${suffix}`,
      idempotency_key: `delivery:two-orders:${suffix}`
    });
    purchases.push({ checkout, completed, grossMinor });
  }

  assert.equal(new Set(purchases.map(({ checkout }) => checkout.order.order_id)).size, 2);
  for (const { checkout, completed, grossMinor } of purchases) {
    assert.equal(completed.delivery.order_id, checkout.order.order_id);
    assert.equal(completed.revenue.order_id, checkout.order.order_id);
    assert.equal(completed.revenue.gross_minor, grossMinor);
    assert.ok(completed.revenue.gross_minor <= checkout.order.gross_minor);
    assert.equal(commerce.getEntitlement(checkout.entitlement.entitlement_id).remaining_units, 0);
  }
  const dashboard = projectCreatorDashboard(ledger.listEvents(), identity.creator_id);
  assert.equal(dashboard.orders.length, 2);
  assert.equal(dashboard.metrics.successful_deliveries, 2);
  assert.equal(dashboard.metrics.creator_share_minor + dashboard.metrics.hatch_share_minor, 3000);
});

async function appendTaskAndArtifact(ledger, checkout, values) {
  const identityChain = {
    order_id: checkout.order.order_id,
    buyer_id: checkout.order.buyer_id,
    creator_id: checkout.order.creator_id,
    agent_id: checkout.order.agent_id,
    product_id: checkout.order.product_id,
    corpus_digest: checkout.order.corpus_digest
  };
  await ledger.append("task.started", {
    ...identityChain,
    entitlement_id: checkout.entitlement.entitlement_id,
    task_id: values.taskId
  }, { idempotencyKey: `task:${values.taskId}` });
  await ledger.append("artifact.created", {
    ...identityChain,
    task_id: values.taskId,
    artifact_id: values.artifactId,
    artifact_digest: `sha256:${"e".repeat(64)}`
  }, { idempotencyKey: `artifact:${values.artifactId}` });
}
