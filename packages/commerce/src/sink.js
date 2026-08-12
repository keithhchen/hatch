import { CommerceInvariantError } from "./ledger.js";

export class LedgerCommerceSink {
  constructor(ledger, options = {}) {
    this.ledger = ledger;
    this.hatchShareBasisPoints = options.hatchShareBasisPoints ?? 1000;
    if (!Number.isInteger(this.hatchShareBasisPoints) || this.hatchShareBasisPoints < 0 || this.hatchShareBasisPoints > 10000) {
      throw new CommerceInvariantError("invalid_split_policy", "hatchShareBasisPoints must be between 0 and 10000");
    }
  }

  async ingest(type, payload, options = {}) {
    const idempotencyKey = options.idempotencyKey ?? `${type}:${eventIdentity(type, payload)}`;
    const event = await this.ledger.append(type, payload, { idempotencyKey });
    if (type !== "delivery.completed") return event;
    const revenue = await this.recognizeDelivery(event);
    return { delivery: event, revenue };
  }

  async recognizeDelivery(deliveryOrId) {
    const events = this.ledger.listEvents();
    const delivery = typeof deliveryOrId === "string"
      ? events.find((event) => event.event_type === "delivery.completed" && event.delivery_id === deliveryOrId)
      : deliveryOrId;
    if (!delivery) {
      throw new CommerceInvariantError("missing_prior_event", `delivery.completed with delivery_id=${deliveryOrId} is required`);
    }
    const order = events.find(
      (event) => event.event_type === "order.placed" && event.order_id === delivery.order_id,
    );
    if (!order) {
      throw new CommerceInvariantError("missing_prior_event", `order.placed with order_id=${delivery.order_id} is required`);
    }
    // A zero-value checkout is a valid entitlement. Record the delivery, but
    // do not create a revenue.recognized event that violates the positive
    // revenue invariant.
    if (order.gross_minor === 0) return undefined;
    const hatchShareMinor = Math.floor(
      (grossMinor * this.hatchShareBasisPoints) / 10000,
    );
    const creatorShareMinor = grossMinor - hatchShareMinor;
    const recognitionId = `recognition_${delivery.delivery_id}`;
    return this.ledger.append("revenue.recognized", {
      schema_version: 1,
      aggregate_type: "revenue",
      aggregate_id: recognitionId,
      tenant_id: delivery.creator_id,
      service_id: "commerce",
      request_id: `revenue.recognized:${delivery.delivery_id}`,
      correlation_id: delivery.correlation_id ?? delivery.request_id ?? delivery.delivery_id,
      causation_id: delivery.event_id,
      recognition_id: recognitionId,
      delivery_id: delivery.delivery_id,
      order_id: delivery.order_id,
      creator_id: delivery.creator_id,
      agent_id: delivery.agent_id,
      product_id: delivery.product_id,
      corpus_digest: delivery.corpus_digest,
      gross_minor: grossMinor,
      creator_share_minor: creatorShareMinor,
      hatch_share_minor: hatchShareMinor,
      currency: order.currency,
      split_rule_version: `hatch-bps:${this.hatchShareBasisPoints}`
    }, { idempotencyKey: `revenue.recognized:${delivery.delivery_id}` });
  }
}

function eventIdentity(type, payload) {
  if (type === "order.placed") return payload.order_id;
  if (type === "entitlement.granted") return payload.entitlement_id;
  if (type === "entitlement.units_reserved") return payload.reservation_id;
  if (type === "entitlement.units_consumed") return payload.reservation_id;
  if (type === "entitlement.units_released") return payload.reservation_id;
  if (type === "entitlement.revoked") return payload.entitlement_id;
  if (type === "task.started") return payload.task_id;
  if (type === "artifact.created") return payload.artifact_id;
  if (type === "delivery.completed") return payload.delivery_id;
  if (type === "order.refunded") return payload.refund_id;
  if (type === "revenue.recognized") return payload.recognition_id;
  if (type === "revenue.reversed") return payload.reversal_id;
  if (type.startsWith("payment.")) return payload.provider_event_id ?? payload.payment_id;
  if (type.startsWith("payout.")) return payload.provider_event_id ?? payload.payout_id ?? payload.adjustment_id;
  throw new CommerceInvariantError("unknown_event_type", `Unsupported commerce event: ${type}`);
}
