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
    const revenue = await this.#recognizeRevenue(event);
    return { delivery: event, revenue };
  }

  async #recognizeRevenue(delivery) {
    const order = this.ledger.listEvents().find(
      (event) => event.event_type === "order.placed" && event.order_id === delivery.order_id,
    );
    if (!order) {
      throw new CommerceInvariantError("missing_prior_event", `order.placed with order_id=${delivery.order_id} is required`);
    }
    const hatchShareMinor = Math.floor(
      (order.gross_minor * this.hatchShareBasisPoints) / 10000,
    );
    const creatorShareMinor = order.gross_minor - hatchShareMinor;
    const recognitionId = `recognition_${delivery.delivery_id}`;
    return this.ledger.append("revenue.recognized", {
      recognition_id: recognitionId,
      delivery_id: delivery.delivery_id,
      order_id: delivery.order_id,
      tenant_id: delivery.tenant_id,
      creator_id: delivery.creator_id,
      product_id: delivery.product_id,
      agent_id: delivery.agent_id,
      gross_minor: order.gross_minor,
      creator_share_minor: creatorShareMinor,
      hatch_share_minor: hatchShareMinor,
      currency: order.currency
    }, { idempotencyKey: `revenue.recognized:${delivery.delivery_id}` });
  }
}

function eventIdentity(type, payload) {
  if (type === "order.placed") return payload.order_id;
  if (type === "entitlement.granted") return payload.entitlement_id;
  if (type === "task.started") return payload.task_id;
  if (type === "artifact.created") return payload.artifact_id;
  if (type === "delivery.completed") return payload.delivery_id;
  if (type === "order.refunded") return payload.refund_id;
  if (type === "revenue.recognized") return payload.recognition_id;
  throw new CommerceInvariantError("unknown_event_type", `Unsupported commerce event: ${type}`);
}
