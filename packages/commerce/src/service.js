import { createHash } from "node:crypto";
import {
  CommerceInvariantError,
  projectActiveOffer,
  projectBuyerOrders,
  projectCreatorDashboard,
  projectDeliveries,
  projectEntitlement,
  projectOfferRevision,
  projectOrder,
  projectRefunds
} from "./ledger.js";
import {
  PAYMENT_STATUSES,
  projectCreatorPayouts,
  projectPayment,
  projectPayments,
  projectPayout,
  projectPayoutAccount,
  projectPayoutBalance
} from "./finance.js";
import { LedgerCommerceSink } from "./sink.js";

export const DEFAULT_RESERVATION_TTL_MS = 15 * 60 * 1000;

/**
 * Small command/query facade shared by the Dashboard BFF and Runtime. The
 * ledger remains backwards compatible, while this facade makes the V2
 * transaction and delivery-unit boundaries explicit.
 */
export class CommerceService {
  constructor(ledger, options = {}) {
    if (!ledger) throw new TypeError("CommerceService requires a ledger");
    this.ledger = ledger;
    this.revenueSink = options.revenueSink ?? new LedgerCommerceSink(ledger, options);
    this.clock = options.clock ?? ledger.clock ?? (() => new Date());
    this.reservationTtlMs = options.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
    this.allowLegacyPaymentConfirmation = options.allowLegacyPaymentConfirmation !== false;
    requirePositiveInteger(this.reservationTtlMs, "reservationTtlMs");
  }

  async createPayment(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["payment_id", "buyer_id", "creator_id", "product_id", "currency", "provider"]);
    const amountMinor = input.amount_minor ?? input.gross_minor;
    requirePositiveInteger(amountMinor, "amount_minor");
    await this.ledger.append("payment.created", compact({
      ...financeMetadata(input, idempotencyKey, "payment", input.payment_id),
      payment_id: input.payment_id,
      order_id: input.order_id,
      checkout_session_id: input.checkout_session_id,
      buyer_id: input.buyer_id,
      creator_id: input.creator_id,
      product_id: input.product_id,
      amount_minor: amountMinor,
      currency: String(input.currency).toUpperCase(),
      provider: input.provider,
      provider_payment_id: input.provider_payment_id,
      status: "pending"
    }), { idempotencyKey: `${idempotencyKey}:payment-create` });
    return projectPayment(this.ledger.listEvents(), input.payment_id);
  }

  async recordPaymentProviderEvent(input) {
    requireFields(input, ["payment_id", "provider", "provider_event_id", "status"]);
    if (!PAYMENT_STATUSES.includes(input.status)) {
      throw new CommerceInvariantError("invalid_payment_status", `Unsupported payment status ${input.status}`);
    }
    if (input.provider_occurred_at !== undefined) dateValue(input.provider_occurred_at, "provider_occurred_at");
    if (input.provider_sequence !== undefined) requireNonNegativeInteger(input.provider_sequence, "provider_sequence");
    const payment = projectPayment(this.ledger.listEvents(), input.payment_id);
    if (!payment) {
      throw new CommerceInvariantError("payment_not_found", `Payment ${input.payment_id} was not found`);
    }
    const providerKey = `payment-provider:${input.provider}:${input.provider_event_id}`;
    const providerPayload = compact({
      payment_id: input.payment_id,
      provider: input.provider,
      provider_event_id: input.provider_event_id,
      status: input.status,
      provider_occurred_at: input.provider_occurred_at,
      provider_sequence: input.provider_sequence,
      provider_payment_id: input.provider_payment_id,
      next_action: input.next_action,
      failure_code: input.failure_code,
      failure_message: input.failure_message
    });
    const mutation = {
      type: "payment.status_changed",
      payload: {
        ...financeMetadata({ ...input, creator_id: payment.creator_id }, providerKey, "payment", input.payment_id),
        ...providerPayload
      },
      idempotencyKey: providerKey
    };
    if (typeof this.ledger.appendManyFromInbox === "function") {
      await this.ledger.appendManyFromInbox(
        `payment-provider:${input.provider}`,
        input.provider_event_id,
        providerPayload,
        [mutation]
      );
    } else {
      await this.ledger.appendMany([mutation]);
    }
    const projected = projectPayment(this.ledger.listEvents(), input.payment_id);
    const providerEvent = projected.provider_events.find((event) => event.provider_event_id === input.provider_event_id);
    return { payment: projected, applied: providerEvent?.applied ?? false };
  }

  /**
   * Consumes a signed provider success and creates its paid order and
   * entitlement in the same ledger transaction. Postgres additionally stores
   * the provider inbox row in that transaction, so a captured payment can
   * never commit without its durable fulfillment authority.
   */
  async confirmCheckoutFromProviderEvent(providerInput, checkoutInput, options = {}) {
    requireFields(providerInput, ["payment_id", "provider", "provider_event_id", "status"]);
    if (providerInput.status !== "succeeded") {
      throw new CommerceInvariantError(
        "payment_not_succeeded",
        "Atomic provider checkout confirmation requires a succeeded provider event"
      );
    }
    const idempotencyKey = requireIdempotencyKey(checkoutInput, options);
    const grossMinor = checkoutInput.gross_minor ?? checkoutInput.amount_minor;
    requirePositiveInteger(grossMinor, "gross_minor");
    const quote = normalizedCheckoutQuote(checkoutInput, grossMinor);
    const includedUnits = checkoutInput.included_units ?? 1;
    requirePositiveInteger(includedUnits, "included_units");
    requireFields(checkoutInput, [
      "buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency", "payment_id"
    ]);
    if (checkoutInput.payment_id !== providerInput.payment_id) {
      throw new CommerceInvariantError("payment_identity_mismatch", "Provider event payment must match checkout");
    }
    if (providerInput.provider_occurred_at !== undefined) {
      dateValue(providerInput.provider_occurred_at, "provider_occurred_at");
    }
    if (providerInput.provider_sequence !== undefined) {
      requireNonNegativeInteger(providerInput.provider_sequence, "provider_sequence");
    }

    const currentPayment = projectPayment(this.ledger.listEvents(), providerInput.payment_id);
    if (!currentPayment) {
      throw new CommerceInvariantError("payment_not_found", `Payment ${providerInput.payment_id} was not found`);
    }
    if (currentPayment.provider !== providerInput.provider) {
      throw new CommerceInvariantError("payment_identity_mismatch", "Provider event must match the Payment provider");
    }
    const currency = String(checkoutInput.currency).toUpperCase();
    assertPaymentMatchesCheckout({ ...currentPayment, status: "succeeded" }, checkoutInput, grossMinor, currency);

    const orderId = checkoutInput.order_id ?? stableId("order", idempotencyKey);
    const entitlementId = checkoutInput.entitlement_id ?? stableId("entitlement", idempotencyKey);
    const orderLineId = checkoutInput.order_line_id ?? `${orderId}:line:1`;
    const identity = {
      buyer_id: checkoutInput.buyer_id,
      creator_id: checkoutInput.creator_id,
      agent_id: checkoutInput.agent_id,
      product_id: checkoutInput.product_id,
      corpus_digest: checkoutInput.corpus_digest
    };
    const providerKey = `payment-provider:${providerInput.provider}:${providerInput.provider_event_id}`;
    const providerPayload = compact({
      payment_id: providerInput.payment_id,
      provider: providerInput.provider,
      provider_event_id: providerInput.provider_event_id,
      status: "succeeded",
      provider_occurred_at: providerInput.provider_occurred_at,
      provider_sequence: providerInput.provider_sequence,
      provider_payment_id: providerInput.provider_payment_id,
      next_action: providerInput.next_action
    });
    const mutations = [
      {
        type: "payment.status_changed",
        payload: {
          ...financeMetadata({ ...providerInput, creator_id: currentPayment.creator_id }, providerKey, "payment", providerInput.payment_id),
          ...providerPayload
        },
        idempotencyKey: providerKey
      },
      {
        type: "order.placed",
        payload: compact({
          ...identity,
          order_id: orderId,
          order_line_id: orderLineId,
          buyer_display_name: checkoutInput.buyer_display_name,
          creator_display_name: checkoutInput.creator_display_name,
          product_name: checkoutInput.product_name,
          creator_snapshot: checkoutInput.creator_snapshot,
          product_snapshot: checkoutInput.product_snapshot,
          release_snapshot: checkoutInput.release_snapshot,
          offer_snapshot: checkoutInput.offer_snapshot,
          release_id: checkoutInput.release_id,
          offer_id: checkoutInput.offer_id,
          offer_revision: checkoutInput.offer_revision,
          ...quote,
          gross_minor: grossMinor,
          currency,
          included_units: includedUnits,
          payment_status: "succeeded",
          payment_id: checkoutInput.payment_id,
          refund_policy_version: checkoutInput.refund_policy_version
        }),
        idempotencyKey: `${idempotencyKey}:order`
      },
      {
        type: "entitlement.granted",
        payload: compact({
          ...identity,
          entitlement_id: entitlementId,
          order_id: orderId,
          order_line_id: orderLineId,
          purchased_release_id: checkoutInput.release_id,
          version_policy: checkoutInput.version_policy ?? "pinned",
          valid_from: checkoutInput.valid_from,
          granted_units: includedUnits,
          expires_at: checkoutInput.valid_until ?? checkoutInput.expires_at
        }),
        idempotencyKey: `${idempotencyKey}:entitlement`
      }
    ];

    if (typeof this.ledger.appendManyFromInbox === "function") {
      await this.ledger.appendManyFromInbox(
        `payment-provider:${providerInput.provider}`,
        providerInput.provider_event_id,
        providerPayload,
        mutations
      );
    } else {
      await this.ledger.appendMany(mutations);
    }
    const events = this.ledger.listEvents();
    const payment = projectPayment(events, providerInput.payment_id);
    const providerEvent = payment.provider_events.find((event) => (
      event.provider_event_id === providerInput.provider_event_id
    ));
    return {
      payment,
      applied: providerEvent?.applied ?? false,
      order: projectOrder(events, orderId),
      entitlement: projectEntitlement(events, entitlementId, { now: clockDate(this.clock) })
    };
  }

  async confirmCheckout(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    const grossMinor = input.gross_minor ?? input.amount_minor;
    requireNonNegativeInteger(grossMinor, "gross_minor");
    const quote = normalizedCheckoutQuote(input, grossMinor);
    const includedUnits = input.included_units ?? 1;
    requirePositiveInteger(includedUnits, "included_units");
    requireFields(input, ["buyer_id", "creator_id", "agent_id", "product_id", "corpus_digest", "currency"]);

    const isFree = grossMinor === 0;
    if (!isFree && (typeof input.payment_id !== "string" || !input.payment_id)) {
      throw new CommerceInvariantError("payment_required", "Paid checkout requires a payment_id");
    }

    const orderId = input.order_id ?? stableId("order", idempotencyKey);
    const entitlementId = input.entitlement_id ?? stableId("entitlement", idempotencyKey);
    const orderLineId = input.order_line_id ?? `${orderId}:line:1`;
    const currency = String(input.currency).toUpperCase();
    const paymentMutations = [];
    let payment = isFree ? null : projectPayment(this.ledger.listEvents(), input.payment_id);
    if (!isFree && !payment) {
      // Compatibility adapter for the pre-V2 call shape. It does not allow the
      // order to bypass the aggregate: the legacy authority is materialized as
      // a succeeded Payment snapshot in the same atomic transaction.
      if (!this.allowLegacyPaymentConfirmation || !new Set(["paid", "succeeded"]).has(input.payment_status)) {
        throw new CommerceInvariantError("payment_required", "Paid checkout requires a succeeded Payment snapshot");
      }
      const provider = input.payment_provider ?? "legacy_compat";
      const providerEventId = input.provider_event_id ?? `legacy-capture:${input.payment_id}`;
      paymentMutations.push(
        {
          type: "payment.created",
          payload: {
            ...financeMetadata(input, idempotencyKey, "payment", input.payment_id),
            payment_id: input.payment_id,
            order_id: orderId,
            buyer_id: input.buyer_id,
            creator_id: input.creator_id,
            product_id: input.product_id,
            amount_minor: grossMinor,
            currency,
            provider,
            provider_payment_id: input.payment_id,
            status: "pending"
          },
          idempotencyKey: `${idempotencyKey}:payment-create`
        },
        {
          type: "payment.status_changed",
          payload: {
            ...financeMetadata(input, idempotencyKey, "payment", input.payment_id),
            payment_id: input.payment_id,
            provider,
            provider_event_id: providerEventId,
            provider_payment_id: input.payment_id,
            status: "succeeded"
          },
          idempotencyKey: `${idempotencyKey}:payment-succeeded`
        }
      );
      payment = {
        payment_id: input.payment_id,
        buyer_id: input.buyer_id,
        creator_id: input.creator_id,
        product_id: input.product_id,
        amount_minor: grossMinor,
        currency,
        status: "succeeded"
      };
    }
    if (!isFree) assertPaymentMatchesCheckout(payment, input, grossMinor, currency);
    const identity = {
      buyer_id: input.buyer_id,
      creator_id: input.creator_id,
      agent_id: input.agent_id,
      product_id: input.product_id,
      corpus_digest: input.corpus_digest
    };
    const orderPayload = compact({
      ...identity,
      order_id: orderId,
      order_line_id: orderLineId,
      buyer_display_name: input.buyer_display_name,
      creator_display_name: input.creator_display_name,
      product_name: input.product_name,
      creator_snapshot: input.creator_snapshot,
      product_snapshot: input.product_snapshot,
      release_snapshot: input.release_snapshot,
      offer_snapshot: input.offer_snapshot,
      release_id: input.release_id,
      offer_id: input.offer_id,
      offer_revision: input.offer_revision,
      ...quote,
      gross_minor: grossMinor,
      currency,
      included_units: includedUnits,
      payment_status: isFree ? "not_required" : "succeeded",
      payment_id: isFree ? null : input.payment_id,
      refund_policy_version: input.refund_policy_version
    });
    const entitlementPayload = compact({
      ...identity,
      entitlement_id: entitlementId,
      order_id: orderId,
      order_line_id: orderLineId,
      purchased_release_id: input.release_id,
      version_policy: input.version_policy ?? "pinned",
      valid_from: input.valid_from,
      granted_units: includedUnits,
      expires_at: input.valid_until ?? input.expires_at
    });

    await this.ledger.appendMany([
      ...paymentMutations,
      {
        type: "order.placed",
        payload: orderPayload,
        idempotencyKey: `${idempotencyKey}:order`
      },
      {
        type: "entitlement.granted",
        payload: entitlementPayload,
        idempotencyKey: `${idempotencyKey}:entitlement`
      }
    ]);

    const events = this.ledger.listEvents();
    return {
      order: projectOrder(events, orderId),
      entitlement: projectEntitlement(events, entitlementId, { now: clockDate(this.clock) })
    };
  }

  async createOfferRevision(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["offer_id", "creator_id", "product_id", "currency"]);
    const revision = Number(input.revision);
    const amountMinor = Number(input.amount_minor);
    const includedUnits = Number(input.included_units ?? 1);
    requirePositiveInteger(revision, "revision");
    requireNonNegativeInteger(amountMinor, "amount_minor");
    requirePositiveInteger(includedUnits, "included_units");
    await this.ledger.append("offer.revision_created", compact({
      offer_id: input.offer_id,
      revision,
      creator_id: input.creator_id,
      product_id: input.product_id,
      purchase_model: input.purchase_model ?? input.model ?? "per_delivery",
      amount_minor: amountMinor,
      currency: input.currency,
      unit: input.unit ?? "delivery",
      included_units: includedUnits,
      refund_policy_version: input.refund_policy_version ?? "v1",
      version_policy: input.version_policy ?? "pinned"
    }), { idempotencyKey: `${idempotencyKey}:offer-revision` });
    return projectOfferRevision(this.ledger.listEvents(), input.offer_id, revision);
  }

  async activateOfferRevision(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["offer_id", "creator_id", "product_id"]);
    const revision = Number(input.revision);
    requirePositiveInteger(revision, "revision");
    await this.ledger.append("offer.activated", compact({
      offer_id: input.offer_id,
      revision,
      creator_id: input.creator_id,
      product_id: input.product_id,
      release_id: input.release_id ?? null,
      corpus_digest: input.corpus_digest ?? null,
      operation_id: input.operation_id ?? null,
      expected_previous_operation_id: input.expected_previous_operation_id
    }), { idempotencyKey: `${idempotencyKey}:offer-activate` });
    return projectOfferRevision(this.ledger.listEvents(), input.offer_id, revision);
  }

  async advanceEntitlementVersion(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, [
      "entitlement_id",
      "from_digest",
      "to_digest",
      "from_release_id",
      "to_release_id",
      "compatibility_declaration_id"
    ]);
    if (!input.from_digest.trim() || !input.to_digest.trim()) {
      throw new CommerceInvariantError("invalid_version_digest", "Version digests must be non-empty strings");
    }
    const eventKey = `${idempotencyKey}:version-advance`;
    const existing = this.ledger.findByIdempotencyKey(eventKey);
    const reason = input.reason ?? "compatible_release_published";
    if (existing) {
      const sameCommand = existing.entitlement_id === input.entitlement_id
        && existing.from_digest === input.from_digest
        && existing.to_digest === input.to_digest
        && existing.from_release_id === input.from_release_id
        && existing.to_release_id === input.to_release_id
        && existing.compatibility_declaration_id === input.compatibility_declaration_id
        && existing.reason === reason
        && (input.actor_id === undefined || existing.actor_id === input.actor_id);
      if (!sameCommand) {
        throw new CommerceInvariantError(
          "idempotency_conflict",
          `Idempotency key ${idempotencyKey} was reused for a different version advance`
        );
      }
      return projectEntitlement(this.ledger.listEvents(), input.entitlement_id, { now: clockDate(this.clock) });
    }

    const entitlement = projectEntitlement(this.ledger.listEvents(), input.entitlement_id, {
      now: clockDate(this.clock)
    });
    if (!entitlement) {
      throw new CommerceInvariantError("entitlement_not_found", `Entitlement ${input.entitlement_id} was not found`);
    }
    if (entitlement.version_policy !== "track_current_compatible") {
      throw new CommerceInvariantError("version_policy_pinned", "Pinned entitlements cannot advance versions");
    }
    if (input.from_digest !== entitlement.effective_corpus_digest) {
      throw new CommerceInvariantError(
        "version_chain_broken",
        `from_digest must equal current effective digest ${entitlement.effective_corpus_digest}`
      );
    }
    if (input.to_digest === input.from_digest) {
      throw new CommerceInvariantError("version_unchanged", "A version advance requires a different target digest");
    }

    await this.ledger.append("entitlement.version_advanced", compact({
      ...financeMetadata(input, idempotencyKey, "entitlement", entitlement.entitlement_id),
      entitlement_id: entitlement.entitlement_id,
      order_id: entitlement.order_id,
      buyer_id: entitlement.buyer_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id,
      product_id: entitlement.product_id,
      corpus_digest: entitlement.purchased_corpus_digest,
      from_digest: input.from_digest,
      to_digest: input.to_digest,
      from_release_id: input.from_release_id,
      to_release_id: input.to_release_id,
      compatibility_declaration_id: input.compatibility_declaration_id,
      reason
    }), { idempotencyKey: eventKey });
    return projectEntitlement(this.ledger.listEvents(), entitlement.entitlement_id, { now: clockDate(this.clock) });
  }

  async authorizeAndReserve(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["entitlement_id", "run_id"]);
    const units = input.units ?? 1;
    requirePositiveInteger(units, "units");
    const now = clockDate(this.clock);
    const lease = reservationLease(input, this.reservationTtlMs, now);
    await this.reconcileExpiredReservations(now);
    const entitlement = projectEntitlement(this.ledger.listEvents(), input.entitlement_id, { now });
    if (!entitlement) {
      throw new CommerceInvariantError("entitlement_not_found", `Entitlement ${input.entitlement_id} was not found`);
    }
    const reservationId = input.reservation_id ?? stableId("reservation", idempotencyKey);
    const event = await this.ledger.append("entitlement.units_reserved", compact({
      reservation_id: reservationId,
      entitlement_id: entitlement.entitlement_id,
      order_id: entitlement.order_id,
      run_id: input.run_id,
      task_id: input.task_id,
      buyer_id: entitlement.buyer_id,
      creator_id: entitlement.creator_id,
      agent_id: entitlement.agent_id,
      product_id: entitlement.product_id,
      corpus_digest: entitlement.corpus_digest,
      effective_corpus_digest: entitlement.effective_corpus_digest,
      units,
      ...lease
    }), { idempotencyKey: `${idempotencyKey}:reserve` });
    const projected = projectEntitlement(this.ledger.listEvents(), entitlement.entitlement_id, { now });
    return {
      reservation: projected.reservations.find((item) => item.reservation_id === reservationId),
      entitlement: projected,
      event
    };
  }

  async reconcileExpiredReservations(now = clockDate(this.clock)) {
    const reconciledAt = dateValue(now, "now");
    const events = this.ledger.listEvents();
    const expired = events
      .filter((event) => event.event_type === "entitlement.granted")
      .flatMap((event) => projectEntitlement(events, event.entitlement_id, { now: reconciledAt })?.reservations ?? [])
      .filter((reservation) => reservation.status === "expired");
    const released = [];

    for (const reservation of expired) {
      try {
        const event = await this.ledger.append("entitlement.units_released", {
          reservation_id: reservation.reservation_id,
          entitlement_id: reservation.entitlement_id,
          order_id: findReservationEvent(events, reservation.reservation_id).order_id,
          reason: "reservation_expired"
        }, { idempotencyKey: `reservation:${reservation.reservation_id}:lease-expired` });
        released.push(event);
      } catch (error) {
        // A run or another reconciler may have terminally released/consumed the
        // same reservation after this snapshot. That state already converged.
        if (error?.code !== "reservation_not_active") throw error;
      }
    }

    return {
      reconciled_at: reconciledAt.toISOString(),
      released_count: released.length,
      released_reservations: released.map((event) => ({
        reservation_id: event.reservation_id,
        entitlement_id: event.entitlement_id,
        order_id: event.order_id,
        status: "released",
        reason: event.reason,
        released_at: event.occurred_at
      }))
    };
  }

  async releaseReservation(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["reservation_id"]);
    const reservation = findReservationEvent(this.ledger.listEvents(), input.reservation_id);
    const event = await this.ledger.append("entitlement.units_released", {
      reservation_id: reservation.reservation_id,
      entitlement_id: reservation.entitlement_id,
      order_id: reservation.order_id,
      reason: input.reason ?? "run_failed"
    }, { idempotencyKey: `${idempotencyKey}:release` });
    return {
      reservation: projectEntitlement(this.ledger.listEvents(), reservation.entitlement_id, { now: clockDate(this.clock) })
        .reservations.find((item) => item.reservation_id === reservation.reservation_id),
      event
    };
  }

  async completeDelivery(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["reservation_id", "artifact_id", "delivery_id"]);
    const reservation = findReservationEvent(this.ledger.listEvents(), input.reservation_id);
    const taskId = input.task_id ?? reservation.task_id ?? reservation.run_id;
    const deliveryPayload = compact({
      delivery_id: input.delivery_id,
      artifact_id: input.artifact_id,
      task_id: taskId,
      reservation_id: reservation.reservation_id,
      entitlement_id: reservation.entitlement_id,
      order_id: reservation.order_id,
      buyer_id: reservation.buyer_id,
      creator_id: reservation.creator_id,
      agent_id: reservation.agent_id,
      product_id: reservation.product_id,
      corpus_digest: reservation.corpus_digest,
      purchased_corpus_digest: reservation.corpus_digest,
      effective_corpus_digest: input.effective_corpus_digest
        ?? reservation.effective_corpus_digest
        ?? reservation.corpus_digest,
      artifact_type: input.artifact_type
    });
    const [delivery] = await this.ledger.appendMany([
      {
        type: "delivery.completed",
        payload: deliveryPayload,
        idempotencyKey: `${idempotencyKey}:delivery`
      },
      {
        type: "entitlement.units_consumed",
        payload: {
          reservation_id: reservation.reservation_id,
          entitlement_id: reservation.entitlement_id,
          order_id: reservation.order_id,
          delivery_id: input.delivery_id
        },
        idempotencyKey: `${idempotencyKey}:consume`
      }
    ]);

    let revenue = null;
    let revenueStatus = "not_applicable";
    let revenueError = null;
    try {
      revenue = await this.revenueSink.recognizeDelivery(delivery);
      if (revenue) revenueStatus = "recognized";
    } catch (error) {
      // Delivery and unit consumption are already authoritative. Finance can be
      // retried independently without turning a saved artifact into a failure.
      revenueStatus = "pending";
      revenueError = { code: error.code ?? "revenue_failed", message: error.message };
    }

    const events = this.ledger.listEvents();
    return {
      delivery: projectDeliveries(events, { orderId: reservation.order_id })
        .find((item) => item.delivery_id === input.delivery_id),
      entitlement: projectEntitlement(events, reservation.entitlement_id, { now: clockDate(this.clock) }),
      revenue,
      revenue_status: revenueStatus,
      revenue_error: revenueError
    };
  }

  async reconcilePendingRevenue() {
    await this.ledger.refresh?.();
    const pending = projectDeliveries(this.ledger.listEvents())
      .filter((delivery) => delivery.revenue_status === "pending");
    const results = [];
    for (const delivery of pending) {
      try {
        const revenue = await this.revenueSink.recognizeDelivery(delivery.delivery_id);
        results.push({
          delivery_id: delivery.delivery_id,
          order_id: delivery.order_id,
          status: revenue ? "recognized" : "not_applicable",
          recognition_id: revenue?.recognition_id ?? null
        });
      } catch (error) {
        results.push({
          delivery_id: delivery.delivery_id,
          order_id: delivery.order_id,
          status: "pending",
          error: {
            code: error?.code ?? "revenue_failed",
            message: error instanceof Error ? error.message : String(error)
          }
        });
      }
    }
    return {
      checked_count: pending.length,
      recognized_count: results.filter((item) => item.status === "recognized").length,
      pending_count: results.filter((item) => item.status === "pending").length,
      results
    };
  }

  async refundOrder(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["order_id"]);
    const events = this.ledger.listEvents();
    const order = projectOrder(events, input.order_id, { now: clockDate(this.clock) });
    if (!order) throw new CommerceInvariantError("order_not_found", `Order ${input.order_id} was not found`);
    const isFree = order.gross_minor === 0;
    if (!isFree) requirePaidRefundConfirmation(input);

    const existing = this.ledger.findByIdempotencyKey(`${idempotencyKey}:refund`);
    if (existing) {
      const sameCommand = existing.order_id === input.order_id &&
        (input.gross_minor === undefined || input.gross_minor === existing.gross_minor) &&
        (input.reason ?? "buyer_request") === existing.reason &&
        (input.actor_id === undefined || input.actor_id === existing.actor_id) &&
        (isFree || (
          input.provider_refund_id === existing.provider_refund_id &&
          input.provider_refund_status === existing.provider_refund_status
        ));
      if (!sameCommand) {
        throw new CommerceInvariantError("idempotency_conflict", `Idempotency key ${idempotencyKey} was reused for a different refund`);
      }
      return this.getOrder(input.order_id);
    }

    const alreadyRefunded = order.refunds.reduce((sum, refund) => sum + refund.gross_minor, 0);
    const refundableMinor = order.gross_minor - alreadyRefunded;
    const refundMinor = isFree ? 0 : input.gross_minor ?? refundableMinor;
    if (isFree && input.gross_minor !== undefined && input.gross_minor !== 0) {
      throw new CommerceInvariantError("refund_exceeds_order", "A free order cancellation must have a zero refund amount");
    }
    if (!isFree && refundMinor !== refundableMinor) {
      throw new CommerceInvariantError("partial_refund_not_supported", "The simple V2 core supports full remaining refunds only");
    }
    if (isFree && order.refunds.length > 0) {
      throw new CommerceInvariantError("order_already_cancelled", `Free order ${order.order_id} was already cancelled`);
    }
    const refundId = input.refund_id ?? stableId("refund", idempotencyKey);
    const mutations = [];
    if (order.entitlement) {
      for (const reservation of order.entitlement.reservations.filter((item) => item.status === "reserved")) {
        mutations.push({
          type: "entitlement.units_released",
          payload: {
            reservation_id: reservation.reservation_id,
            entitlement_id: order.entitlement.entitlement_id,
            order_id: order.order_id,
            reason: "order_refunded"
          },
          idempotencyKey: `${idempotencyKey}:release:${reservation.reservation_id}`
        });
      }
    }
    mutations.push({
      type: "order.refunded",
      payload: {
        refund_id: refundId,
        order_id: order.order_id,
        buyer_id: order.buyer_id,
        creator_id: order.creator_id,
        agent_id: order.agent_id,
        product_id: order.product_id,
        currency: order.currency,
        gross_minor: refundMinor,
        payment_id: order.payment_id,
        reason: input.reason ?? "buyer_request",
        actor_id: input.actor_id ?? order.buyer_id,
        ...(isFree ? {} : {
          provider_refund_id: input.provider_refund_id,
          provider_refund_status: input.provider_refund_status
        })
      },
      idempotencyKey: `${idempotencyKey}:refund`
    });
    if (!isFree && order.payment) {
      mutations.push({
        type: "payment.refunded",
        payload: {
          ...financeMetadata(input, idempotencyKey, "payment", order.payment_id),
          payment_id: order.payment_id,
          refund_id: refundId,
          order_id: order.order_id,
          creator_id: order.creator_id,
          currency: order.currency,
          amount_minor: refundMinor,
          provider_refund_id: input.provider_refund_id
        },
        idempotencyKey: `${idempotencyKey}:payment-refunded`
      });
    }
    for (const recognition of order.revenue.filter((item) => item.status !== "reversed")) {
      const reversalId = stableId("reversal", `${refundId}:${recognition.recognition_id}`);
      mutations.push({
        type: "revenue.reversed",
        payload: compact({
          ...financeMetadata(input, idempotencyKey, "revenue", recognition.recognition_id),
          reversal_id: reversalId,
          recognition_id: recognition.recognition_id,
          refund_id: refundId,
          delivery_id: recognition.delivery_id,
          order_id: order.order_id,
          creator_id: order.creator_id,
          agent_id: order.agent_id,
          product_id: order.product_id,
          corpus_digest: order.corpus_digest,
          currency: order.currency,
          gross_minor: recognition.gross_minor,
          creator_share_minor: recognition.creator_share_minor,
          hatch_share_minor: recognition.hatch_share_minor,
          reason: input.reason ?? "order_refunded",
          causation_id: input.provider_refund_id
        }),
        idempotencyKey: `${idempotencyKey}:reverse:${recognition.recognition_id}`
      });
      if (recognition.creator_share_minor > 0) {
        mutations.push({
          type: "payout.adjustment",
          payload: {
            ...financeMetadata(input, idempotencyKey, "payout", `${order.creator_id}:${order.currency}`),
            adjustment_id: stableId("adjustment", reversalId),
            creator_id: order.creator_id,
            currency: order.currency,
            amount_minor: -recognition.creator_share_minor,
            reason: "order_refunded",
            source_type: "revenue_reversal",
            source_id: reversalId,
            order_id: order.order_id,
            refund_id: refundId
          },
          idempotencyKey: `${idempotencyKey}:adjust:${recognition.recognition_id}`
        });
      }
    }
    if (order.entitlement) {
      mutations.push({
        type: "entitlement.revoked",
        payload: {
          entitlement_id: order.entitlement.entitlement_id,
          order_id: order.order_id,
          buyer_id: order.buyer_id,
          creator_id: order.creator_id,
          agent_id: order.agent_id,
          product_id: order.product_id,
          reason: "order_refunded"
        },
        idempotencyKey: `${idempotencyKey}:revoke`
      });
    }
    await this.ledger.appendMany(mutations);
    return this.getOrder(order.order_id);
  }

  async updatePayoutAccount(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["creator_id", "currency", "provider", "status"]);
    const currency = String(input.currency).toUpperCase();
    await this.ledger.append("payout.account_updated", compact({
      ...financeMetadata(input, idempotencyKey, "payout_account", `${input.creator_id}:${currency}`),
      creator_id: input.creator_id,
      currency,
      provider: input.provider,
      provider_account_id: input.provider_account_id,
      status: input.status,
      requirements: input.requirements
    }), { idempotencyKey: `${idempotencyKey}:payout-account` });
    return projectPayoutAccount(this.ledger.listEvents(), input.creator_id, currency);
  }

  async createPayout(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["creator_id", "currency", "batch_id"]);
    const currency = String(input.currency).toUpperCase();
    const existing = this.ledger.findByIdempotencyKey(`${idempotencyKey}:payout-reserve`);
    if (existing) {
      const sameCommand = existing.creator_id === input.creator_id
        && existing.currency === currency
        && existing.batch_id === input.batch_id
        && (input.payout_id === undefined || input.payout_id === existing.payout_id)
        && (input.amount_minor === undefined || input.amount_minor === existing.amount_minor);
      if (!sameCommand) {
        throw new CommerceInvariantError("idempotency_conflict", "Payout idempotency key was reused with a different command");
      }
      return projectPayout(this.ledger.listEvents(), existing.payout_id);
    }
    const events = this.ledger.listEvents();
    const account = projectPayoutAccount(events, input.creator_id, currency);
    if (account.status !== "active") {
      throw new CommerceInvariantError("payout_account_not_active", "Creator payout account must be active");
    }
    const balance = projectPayoutBalance(events, input.creator_id, currency);
    const amountMinor = input.amount_minor ?? balance.available_minor;
    requirePositiveInteger(amountMinor, "amount_minor");
    const payoutId = input.payout_id ?? stableId("payout", `${input.creator_id}:${currency}:${input.batch_id}`);
    await this.ledger.append("payout.reserved", {
      ...financeMetadata(input, idempotencyKey, "payout", payoutId),
      payout_id: payoutId,
      batch_id: input.batch_id,
      creator_id: input.creator_id,
      currency,
      amount_minor: amountMinor,
      provider: account.provider,
      provider_account_id: account.provider_account_id
    }, { idempotencyKey: `${idempotencyKey}:payout-reserve` });
    return projectPayout(this.ledger.listEvents(), payoutId);
  }

  async submitPayout(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["payout_id", "provider_payout_id"]);
    const payout = projectPayout(this.ledger.listEvents(), input.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${input.payout_id} was not found`);
    await this.ledger.append("payout.submitted", {
      ...financeMetadata(input, idempotencyKey, "payout", payout.payout_id),
      payout_id: payout.payout_id,
      provider: payout.provider,
      provider_payout_id: input.provider_payout_id,
      attempt: payout.attempt
    }, { idempotencyKey: `${idempotencyKey}:payout-submit` });
    return projectPayout(this.ledger.listEvents(), payout.payout_id);
  }

  async recordPayoutProviderEvent(input) {
    requireFields(input, ["payout_id", "provider", "provider_event_id", "provider_payout_id", "status"]);
    const eventType = {
      in_transit: "payout.in_transit",
      paid: "payout.paid",
      failed: "payout.failed"
    }[input.status];
    if (!eventType) {
      throw new CommerceInvariantError("invalid_payout_status", `Unsupported payout provider status ${input.status}`);
    }
    const payout = projectPayout(this.ledger.listEvents(), input.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${input.payout_id} was not found`);
    const providerKey = `payout-provider:${input.provider}:${input.provider_event_id}`;
    const providerPayload = compact({
      payout_id: input.payout_id,
      provider: input.provider,
      provider_event_id: input.provider_event_id,
      provider_payout_id: input.provider_payout_id,
      status: input.status,
      provider_occurred_at: input.provider_occurred_at,
      failure_code: input.failure_code,
      failure_message: input.failure_message
    });
    const mutation = {
      type: eventType,
      payload: {
        ...financeMetadata({ ...input, creator_id: payout.creator_id }, providerKey, "payout", input.payout_id),
        ...providerPayload
      },
      idempotencyKey: providerKey
    };
    if (typeof this.ledger.appendManyFromInbox === "function") {
      await this.ledger.appendManyFromInbox(
        `payout-provider:${input.provider}`,
        input.provider_event_id,
        providerPayload,
        [mutation]
      );
    } else {
      await this.ledger.appendMany([mutation]);
    }
    return projectPayout(this.ledger.listEvents(), payout.payout_id);
  }

  async recordPayoutReconciliationFailure(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["payout_id", "provider", "provider_payout_id", "failure_code"]);
    const payout = projectPayout(this.ledger.listEvents(), input.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${input.payout_id} was not found`);
    await this.ledger.append("payout.reconciliation_failed", compact({
      ...financeMetadata({ ...input, creator_id: payout.creator_id }, idempotencyKey, "payout", payout.payout_id),
      payout_id: payout.payout_id,
      provider: input.provider,
      provider_payout_id: input.provider_payout_id,
      failure_code: input.failure_code,
      actor_id: input.actor_id ?? "payout-reconciler",
      service_name: input.service_name ?? "dashboard-bff",
      reason: "payout_provider_status_query_failed"
    }), { idempotencyKey });
    return projectPayout(this.ledger.listEvents(), payout.payout_id);
  }

  async retryPayout(input, options = {}) {
    const idempotencyKey = requireIdempotencyKey(input, options);
    requireFields(input, ["payout_id"]);
    const payout = projectPayout(this.ledger.listEvents(), input.payout_id);
    if (!payout) throw new CommerceInvariantError("payout_not_found", `Payout ${input.payout_id} was not found`);
    await this.ledger.append("payout.retried", {
      ...financeMetadata(input, idempotencyKey, "payout", payout.payout_id),
      payout_id: payout.payout_id,
      reason: input.reason ?? "provider_failure_retry"
    }, { idempotencyKey: `${idempotencyKey}:payout-retry` });
    return projectPayout(this.ledger.listEvents(), payout.payout_id);
  }

  getOrder(orderId) {
    if (typeof this.ledger.readOrder === "function") {
      return this.ledger.readOrder(orderId, { now: clockDate(this.clock) });
    }
    return projectOrder(this.ledger.listEvents(), orderId, { now: clockDate(this.clock) });
  }

  getPayment(paymentId) {
    if (typeof this.ledger.readPayment === "function") return this.ledger.readPayment(paymentId);
    return projectPayment(this.ledger.listEvents(), paymentId);
  }

  listPayments(filters = {}) {
    if (typeof this.ledger.readPayments === "function") return this.ledger.readPayments(filters);
    return projectPayments(this.ledger.listEvents(), filters);
  }

  getPayout(payoutId) {
    if (typeof this.ledger.readPayout === "function") return this.ledger.readPayout(payoutId);
    return projectPayout(this.ledger.listEvents(), payoutId);
  }

  getPayoutAccount(creatorId, currency = "USD") {
    if (typeof this.ledger.readPayoutAccount === "function") {
      return this.ledger.readPayoutAccount(creatorId, currency);
    }
    return projectPayoutAccount(this.ledger.listEvents(), creatorId, currency);
  }

  listPayoutAccounts(filters = {}) {
    if (typeof this.ledger.readPayoutAccounts === "function") {
      return this.ledger.readPayoutAccounts(filters);
    }
    const normalizedCurrency = filters.currency ? String(filters.currency).toUpperCase() : null;
    const events = this.ledger.listEvents();
    const pairs = new Map();
    for (const event of events.filter((item) => item.event_type === "payout.account_updated")) {
      pairs.set(JSON.stringify([event.creator_id, event.currency]), [event.creator_id, event.currency]);
    }
    return [...pairs.values()]
      .map(([creatorId, currency]) => projectPayoutAccount(events, creatorId, currency))
      .filter((account) => !filters.creatorId || account.creator_id === filters.creatorId)
      .filter((account) => !normalizedCurrency || account.currency === normalizedCurrency)
      .filter((account) => !filters.status || account.status === filters.status)
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at));
  }

  getPayoutBalance(creatorId, currency = "USD") {
    if (typeof this.ledger.readPayoutBalance === "function") {
      return this.ledger.readPayoutBalance(creatorId, currency);
    }
    return projectPayoutBalance(this.ledger.listEvents(), creatorId, currency);
  }

  listCreatorPayouts(creatorId, currency) {
    if (typeof this.ledger.readCreatorPayouts === "function") {
      return this.ledger.readCreatorPayouts(creatorId, currency);
    }
    return projectCreatorPayouts(this.ledger.listEvents(), creatorId, currency);
  }

  getOfferRevision(offerId, revision) {
    if (typeof this.ledger.readOfferRevision === "function") {
      return this.ledger.readOfferRevision(offerId, revision);
    }
    return projectOfferRevision(this.ledger.listEvents(), offerId, revision);
  }

  getActiveOffer(creatorId, productId) {
    if (typeof this.ledger.readActiveOffer === "function") {
      return this.ledger.readActiveOffer(creatorId, productId);
    }
    return projectActiveOffer(this.ledger.listEvents(), creatorId, productId);
  }

  getEntitlement(entitlementId) {
    if (typeof this.ledger.readEntitlement === "function") {
      return this.ledger.readEntitlement(entitlementId, { now: clockDate(this.clock) });
    }
    return projectEntitlement(this.ledger.listEvents(), entitlementId, { now: clockDate(this.clock) });
  }

  listBuyerOrders(buyerId) {
    if (typeof this.ledger.readBuyerOrders === "function") return this.ledger.readBuyerOrders(buyerId);
    return projectBuyerOrders(this.ledger.listEvents(), buyerId);
  }

  listBuyerEntitlements(buyerId) {
    if (typeof this.ledger.readBuyerEntitlements === "function") {
      return this.ledger.readBuyerEntitlements(buyerId, { now: clockDate(this.clock) });
    }
    const events = this.ledger.listEvents();
    return events
      .filter((event) => event.event_type === "entitlement.granted" && event.buyer_id === buyerId)
      .map((event) => projectEntitlement(events, event.entitlement_id, { now: clockDate(this.clock) }));
  }

  listCreatorOrders(creatorId) {
    if (typeof this.ledger.readCreatorOrders === "function") {
      return this.ledger.readCreatorOrders(creatorId, { now: clockDate(this.clock) });
    }
    const events = this.ledger.listEvents();
    return events
      .filter((event) => event.event_type === "order.placed" && event.creator_id === creatorId)
      .map((event) => projectOrder(events, event.order_id, { now: clockDate(this.clock) }))
      .sort((left, right) => right.occurred_at.localeCompare(left.occurred_at));
  }

  listDeliveries(filters = {}) {
    if (typeof this.ledger.readDeliveries === "function") return this.ledger.readDeliveries(filters);
    return projectDeliveries(this.ledger.listEvents(), filters);
  }

  listRefunds(filters = {}) {
    if (typeof this.ledger.readRefunds === "function") return this.ledger.readRefunds(filters);
    return projectRefunds(this.ledger.listEvents(), filters);
  }

  getCreatorDashboard(creatorId) {
    if (typeof this.ledger.readCreatorDashboard === "function") {
      return this.ledger.readCreatorDashboard(creatorId);
    }
    return projectCreatorDashboard(this.ledger.listEvents(), creatorId);
  }

  getReservation(reservationId) {
    if (typeof this.ledger.readReservation === "function") {
      return this.ledger.readReservation(reservationId, { now: clockDate(this.clock) });
    }
    const events = this.ledger.listEvents();
    const entitlementId = events.find((event) => (
      event.event_type === "entitlement.units_reserved" && event.reservation_id === reservationId
    ))?.entitlement_id;
    return entitlementId
      ? projectEntitlement(events, entitlementId, { now: clockDate(this.clock) })
        ?.reservations.find((reservation) => reservation.reservation_id === reservationId)
      : undefined;
  }

  listRevenues(filters = {}) {
    if (typeof this.ledger.readRevenues === "function") return this.ledger.readRevenues(filters);
    return this.ledger.listEvents()
      .filter((event) => event.event_type === "revenue.recognized")
      .filter((event) => !filters.orderId || event.order_id === filters.orderId)
      .filter((event) => !filters.deliveryId || event.delivery_id === filters.deliveryId)
      .filter((event) => !filters.creatorId || event.creator_id === filters.creatorId)
      .map((event) => structuredClone(event));
  }
}

function requireIdempotencyKey(input, options) {
  const value = options.idempotencyKey ?? input?.idempotency_key;
  if (typeof value !== "string" || !value.trim()) {
    throw new CommerceInvariantError("idempotency_required", "Every commerce command requires an idempotency key");
  }
  return value.trim();
}

function requireFields(value, fields) {
  for (const field of fields) {
    if (typeof value?.[field] !== "string" || !value[field]) {
      throw new CommerceInvariantError("invalid_command", `${field} is required`);
    }
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CommerceInvariantError("invalid_command", `${field} must be a positive integer`);
  }
}

function requireNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CommerceInvariantError("invalid_command", `${field} must be a non-negative integer`);
  }
}

function normalizedCheckoutQuote(input, grossMinor) {
  const subtotalMinor = input.subtotal_minor ?? grossMinor;
  const discountMinor = input.discount_minor ?? 0;
  const taxMinor = input.tax_minor === undefined ? null : input.tax_minor;
  const totalMinor = input.total_minor ?? grossMinor;
  requireNonNegativeInteger(subtotalMinor, "subtotal_minor");
  requireNonNegativeInteger(discountMinor, "discount_minor");
  if (taxMinor !== null) requireNonNegativeInteger(taxMinor, "tax_minor");
  requireNonNegativeInteger(totalMinor, "total_minor");
  if (discountMinor > subtotalMinor) {
    throw new CommerceInvariantError("invalid_command", "discount_minor cannot exceed subtotal_minor");
  }
  const computedTotal = subtotalMinor - discountMinor + (taxMinor ?? 0);
  if (computedTotal !== totalMinor || totalMinor !== grossMinor) {
    throw new CommerceInvariantError(
      "quote_total_mismatch",
      "subtotal_minor - discount_minor + calculated tax must equal total_minor and gross_minor"
    );
  }
  return {
    subtotal_minor: subtotalMinor,
    discount_minor: discountMinor,
    tax_minor: taxMinor,
    total_minor: totalMinor
  };
}

function reservationLease(input, defaultTtlMs, now) {
  const ttl = input.ttl_ms ?? input.ttl;
  if (input.ttl_ms !== undefined && input.ttl !== undefined && input.ttl_ms !== input.ttl) {
    throw new CommerceInvariantError("invalid_reservation_lease", "ttl and ttl_ms must match when both are supplied");
  }
  if (input.expires_at !== undefined && ttl !== undefined) {
    throw new CommerceInvariantError("invalid_reservation_lease", "Use expires_at or ttl, not both");
  }
  if (input.expires_at !== undefined) {
    if (typeof input.expires_at !== "string") {
      throw new CommerceInvariantError("invalid_reservation_lease", "expires_at must be an ISO timestamp");
    }
    const expiresAt = dateValue(input.expires_at, "expires_at");
    if (expiresAt.getTime() <= now.getTime()) {
      throw new CommerceInvariantError("invalid_reservation_lease", "expires_at must be in the future");
    }
    return { expires_at: expiresAt.toISOString() };
  }
  const leaseTtlMs = ttl ?? defaultTtlMs;
  requirePositiveInteger(leaseTtlMs, "ttl");
  return { lease_ttl_ms: leaseTtlMs };
}

function requirePaidRefundConfirmation(input) {
  if (typeof input.provider_refund_id !== "string" || !input.provider_refund_id.trim()) {
    throw new CommerceInvariantError(
      "provider_refund_confirmation_required",
      "Paid refunds require a provider_refund_id"
    );
  }
  if (input.provider_refund_status !== "succeeded") {
    throw new CommerceInvariantError(
      "provider_refund_not_confirmed",
      "Paid refunds require provider_refund_status=succeeded"
    );
  }
}

function assertPaymentMatchesCheckout(payment, input, grossMinor, currency) {
  if (!payment || payment.status !== "succeeded") {
    throw new CommerceInvariantError("payment_required", "Paid checkout requires a succeeded Payment snapshot");
  }
  if ((payment.refunded_minor ?? 0) > 0) {
    throw new CommerceInvariantError("payment_not_chargeable", "A refunded Payment cannot confirm checkout");
  }
  for (const field of ["buyer_id", "creator_id", "product_id"]) {
    if (payment[field] !== input[field]) {
      throw new CommerceInvariantError("payment_identity_mismatch", `Payment ${field} must match checkout`);
    }
  }
  if (payment.amount_minor !== grossMinor || payment.currency !== currency) {
    throw new CommerceInvariantError("payment_amount_mismatch", "Payment amount and currency must match checkout");
  }
}

function financeMetadata(input, requestId, aggregateType, aggregateId) {
  const correlationId = input.correlation_id ?? input.request_id ?? requestId;
  return compact({
    schema_version: 1,
    aggregate_type: aggregateType,
    aggregate_id: aggregateId,
    tenant_id: input.tenant_id ?? input.creator_id,
    actor_type: input.actor_type ?? (input.provider_event_id ? "service" : undefined),
    actor_id: input.actor_id ?? (input.provider_event_id ? input.provider : undefined),
    service_id: input.service_id ?? "commerce",
    request_id: input.request_id ?? requestId,
    correlation_id: correlationId,
    causation_id: input.causation_id ?? input.provider_event_id,
    reason: input.reason ?? input.status
  });
}

function clockDate(clock) {
  return dateValue(clock(), "clock");
}

function dateValue(value, field) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new CommerceInvariantError("invalid_command", `${field} must be a valid timestamp`);
  }
  return date;
}

function stableId(prefix, idempotencyKey) {
  const digest = createHash("sha256").update(`${prefix}:${idempotencyKey}`).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function findReservationEvent(events, reservationId) {
  const reservation = events.find((event) => (
    event.event_type === "entitlement.units_reserved" && event.reservation_id === reservationId
  ));
  if (!reservation) {
    throw new CommerceInvariantError("reservation_not_found", `Reservation ${reservationId} was not found`);
  }
  return reservation;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
