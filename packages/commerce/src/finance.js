const PAYMENT_EVENT_TYPES = new Set([
  "payment.created",
  "payment.status_changed",
  "payment.refunded"
]);

const PAYOUT_EVENT_TYPES = new Set([
  "payout.reserved",
  "payout.submitted",
  "payout.in_transit",
  "payout.paid",
  "payout.failed",
  "payout.reconciliation_failed",
  "payout.retried"
]);

export const PAYMENT_STATUSES = Object.freeze([
  "pending",
  "requires_action",
  "succeeded",
  "failed",
  "cancelled"
]);

/**
 * Projects the authoritative payment snapshot. Provider notifications remain
 * visible in provider_events, but an old or terminally regressive notification
 * cannot move the aggregate backwards.
 */
export function projectPayment(events, paymentId) {
  const paymentEvents = events.filter((event) => (
    PAYMENT_EVENT_TYPES.has(event.event_type) && event.payment_id === paymentId
  ));
  const created = paymentEvents.find((event) => event.event_type === "payment.created");
  if (!created) return undefined;

  let status = created.status ?? "pending";
  let appliedCursor = { sequence: null, time: Number.NEGATIVE_INFINITY };
  let lastStatusEvent = created;
  const providerEvents = [];
  for (const event of paymentEvents.filter((item) => item.event_type === "payment.status_changed")) {
    const applied = canApplyPaymentTransition(status, event.status, appliedCursor, providerCursor(event));
    providerEvents.push({
      provider_event_id: event.provider_event_id,
      status: event.status,
      provider_occurred_at: event.provider_occurred_at ?? event.occurred_at,
      provider_sequence: event.provider_sequence ?? null,
      next_action: structuredClone(event.next_action ?? null),
      failure_code: event.failure_code ?? null,
      applied,
      event_id: event.event_id
    });
    if (!applied) continue;
    status = event.status;
    appliedCursor = providerCursor(event);
    lastStatusEvent = event;
  }

  const refunds = paymentEvents
    .filter((event) => event.event_type === "payment.refunded")
    .map((event) => ({
      refund_id: event.refund_id,
      provider_refund_id: event.provider_refund_id ?? null,
      amount_minor: event.amount_minor,
      occurred_at: event.occurred_at,
      event_id: event.event_id
    }));
  const refundedMinor = refunds.reduce((sum, refund) => sum + refund.amount_minor, 0);
  const settlementStatus = refundedMinor >= created.amount_minor && refundedMinor > 0
    ? "refunded"
    : refundedMinor > 0
      ? "partially_refunded"
      : status;

  return {
    payment_id: created.payment_id,
    order_id: created.order_id ?? null,
    checkout_session_id: created.checkout_session_id ?? null,
    buyer_id: created.buyer_id,
    creator_id: created.creator_id,
    product_id: created.product_id,
    amount_minor: created.amount_minor,
    currency: created.currency,
    provider: created.provider,
    provider_payment_id: lastStatusEvent.provider_payment_id ?? created.provider_payment_id ?? null,
    status,
    settlement_status: settlementStatus,
    refunded_minor: refundedMinor,
    created_at: created.occurred_at,
    updated_at: lastStatusEvent.occurred_at,
    latest_provider_event_id: lastStatusEvent.provider_event_id ?? null,
    next_action: structuredClone(status === "requires_action" ? lastStatusEvent.next_action ?? null : null),
    failure: new Set(["failed", "cancelled"]).has(status)
      ? {
          code: lastStatusEvent.failure_code ?? null,
          message: lastStatusEvent.failure_message ?? null
        }
      : null,
    provider_events: providerEvents,
    refunds
  };
}

export function projectPayments(events, filters = {}) {
  return events
    .filter((event) => event.event_type === "payment.created")
    .filter((event) => !filters.buyerId || event.buyer_id === filters.buyerId)
    .filter((event) => !filters.creatorId || event.creator_id === filters.creatorId)
    .map((event) => projectPayment(events, event.payment_id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function projectPayoutAccount(events, creatorId, currency) {
  const normalizedCurrency = String(currency ?? "USD").toUpperCase();
  const event = events.findLast((item) => (
    item.event_type === "payout.account_updated"
    && item.creator_id === creatorId
    && item.currency === normalizedCurrency
  ));
  if (!event) {
    return {
      creator_id: creatorId,
      currency: normalizedCurrency,
      status: "not_connected",
      provider: null,
      provider_account_id: null,
      updated_at: null
    };
  }
  return {
    creator_id: event.creator_id,
    currency: event.currency,
    status: event.status,
    provider: event.provider,
    provider_account_id: event.provider_account_id ?? null,
    requirements: structuredClone(event.requirements ?? []),
    updated_at: event.occurred_at
  };
}

export function projectPayout(events, payoutId) {
  const payoutEvents = events.filter((event) => (
    PAYOUT_EVENT_TYPES.has(event.event_type) && event.payout_id === payoutId
  ));
  const reserved = payoutEvents.find((event) => event.event_type === "payout.reserved");
  if (!reserved) return undefined;

  let status = "reserved";
  let attempt = 1;
  let updatedAt = reserved.occurred_at;
  let providerPayoutId = reserved.provider_payout_id ?? null;
  let failure = null;
  let reconciliationRetryCount = 0;
  let reconciliationLastError = null;
  let submittedAt = null;
  const transitions = [];
  for (const event of payoutEvents.slice(1)) {
    let applied = true;
    const providerTransition = new Set(["payout.in_transit", "payout.paid", "payout.failed"])
      .has(event.event_type);
    if (providerTransition && (!providerPayoutId || event.provider_payout_id !== providerPayoutId)) {
      transitions.push({ event_id: event.event_id, event_type: event.event_type, applied: false });
      continue;
    }
    if (status === "paid") applied = false;
    if (event.event_type === "payout.submitted" && status === "reserved") {
      status = "submitted";
      providerPayoutId = event.provider_payout_id;
      submittedAt = event.occurred_at;
    } else if (event.event_type === "payout.in_transit" && new Set(["submitted", "in_transit"]).has(status)) {
      status = "in_transit";
      reconciliationLastError = null;
    } else if (event.event_type === "payout.paid" && status !== "paid") {
      status = "paid";
      reconciliationLastError = null;
    } else if (event.event_type === "payout.failed" && status !== "paid") {
      status = "failed";
      failure = { code: event.failure_code ?? null, message: event.failure_message ?? null };
      reconciliationLastError = null;
    } else if (event.event_type === "payout.reconciliation_failed" && new Set(["submitted", "in_transit"]).has(status)) {
      reconciliationRetryCount += 1;
      reconciliationLastError = {
        code: event.failure_code,
        occurred_at: event.occurred_at
      };
    } else if (event.event_type === "payout.retried" && status === "failed") {
      status = "reserved";
      attempt += 1;
      providerPayoutId = null;
      failure = null;
      submittedAt = null;
      reconciliationRetryCount = 0;
      reconciliationLastError = null;
    } else {
      applied = false;
    }
    transitions.push({ event_id: event.event_id, event_type: event.event_type, applied });
    if (applied) updatedAt = event.occurred_at;
  }
  return {
    payout_id: reserved.payout_id,
    batch_id: reserved.batch_id,
    creator_id: reserved.creator_id,
    currency: reserved.currency,
    amount_minor: reserved.amount_minor,
    status,
    attempt,
    provider: reserved.provider,
    provider_account_id: reserved.provider_account_id ?? null,
    provider_payout_id: providerPayoutId,
    failure,
    submitted_at: submittedAt,
    reconciliation: {
      retry_count: reconciliationRetryCount,
      last_error: reconciliationLastError
    },
    created_at: reserved.occurred_at,
    updated_at: updatedAt,
    transitions
  };
}

export function projectCreatorPayouts(events, creatorId, currency) {
  const normalizedCurrency = currency ? String(currency).toUpperCase() : null;
  return events
    .filter((event) => event.event_type === "payout.reserved" && event.creator_id === creatorId)
    .filter((event) => !normalizedCurrency || event.currency === normalizedCurrency)
    .map((event) => projectPayout(events, event.payout_id))
    .sort((left, right) => right.created_at.localeCompare(left.created_at));
}

export function projectPayoutBalance(events, creatorId, currency) {
  const normalizedCurrency = String(currency ?? "USD").toUpperCase();
  const recognizedMinor = events
    .filter((event) => event.event_type === "revenue.recognized")
    .filter((event) => event.creator_id === creatorId && event.currency === normalizedCurrency)
    .reduce((sum, event) => sum + event.creator_share_minor, 0);
  const adjustments = events
    .filter((event) => event.event_type === "payout.adjustment")
    .filter((event) => event.creator_id === creatorId && event.currency === normalizedCurrency);
  const adjustmentMinor = adjustments.reduce((sum, event) => sum + event.amount_minor, 0);
  const reversedMinor = events
    .filter((event) => event.event_type === "revenue.reversed")
    .filter((event) => event.creator_id === creatorId && event.currency === normalizedCurrency)
    .reduce((sum, event) => sum + event.creator_share_minor, 0);
  // A refund adjustment is the payout-side audit mirror of a revenue reversal,
  // not a second debit. Other adjustment categories affect available directly.
  const independentAdjustmentMinor = adjustments
    .filter((event) => event.source_type !== "revenue_reversal")
    .reduce((sum, event) => sum + event.amount_minor, 0);
  const payouts = projectCreatorPayouts(events, creatorId, normalizedCurrency);
  const committedMinor = payouts
    .filter((payout) => new Set(["reserved", "submitted", "in_transit", "paid"]).has(payout.status))
    .reduce((sum, payout) => sum + payout.amount_minor, 0);
  const inTransitMinor = payouts
    .filter((payout) => new Set(["submitted", "in_transit"]).has(payout.status))
    .reduce((sum, payout) => sum + payout.amount_minor, 0);
  const paidMinor = payouts
    .filter((payout) => payout.status === "paid")
    .reduce((sum, payout) => sum + payout.amount_minor, 0);
  return {
    creator_id: creatorId,
    currency: normalizedCurrency,
    pending_minor: 0,
    recognized_minor: recognizedMinor,
    reversed_minor: reversedMinor,
    adjustments_minor: adjustmentMinor,
    available_minor: Math.max(0, recognizedMinor - reversedMinor + independentAdjustmentMinor - committedMinor),
    reserved_minor: payouts
      .filter((payout) => payout.status === "reserved")
      .reduce((sum, payout) => sum + payout.amount_minor, 0),
    in_transit_minor: inTransitMinor,
    paid_minor: paidMinor,
    account: projectPayoutAccount(events, creatorId, normalizedCurrency),
    payouts,
    adjustments: adjustments.map((event) => structuredClone(event))
  };
}

function canApplyPaymentTransition(current, next, currentCursor, nextCursor) {
  if (current === "succeeded") return false;
  if (next === "succeeded") return true;
  if (current === "cancelled") return false;
  if (nextCursor.sequence !== null && currentCursor.sequence !== null) {
    return nextCursor.sequence > currentCursor.sequence;
  }
  return nextCursor.time >= currentCursor.time;
}

function providerCursor(event) {
  return {
    sequence: Number.isSafeInteger(event.provider_sequence) ? event.provider_sequence : null,
    time: Date.parse(event.provider_occurred_at ?? event.occurred_at)
  };
}
