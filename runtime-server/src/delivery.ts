import { createHash } from "node:crypto";

export type CommerceEventType = "task.started" | "artifact.created" | "delivery.completed";

/** Structurally compatible with packages/commerce CommerceLedger. */
export interface CommerceEventSink {
  append(
    type: CommerceEventType,
    payload: Record<string, unknown>,
    options: { idempotencyKey: string }
  ): Promise<unknown>;
  findByIdempotencyKey?(key: string): unknown | Promise<unknown>;
  /** Authoritative entitlement snapshot used to prevent version rollback after reconnect. */
  getEntitlement?(entitlementId: string): unknown | Promise<unknown>;
  /** Optional non-mutating startup/readiness probe for remote sinks. */
  checkReady?(): Promise<void>;
  advanceEntitlementVersion?(
    input: {
      entitlement_id: string;
      from_digest: string;
      to_digest: string;
      from_release_id?: string;
      to_release_id?: string;
      compatibility_declaration_id: string;
      reason: "compatible_release_published";
    },
    options: { idempotencyKey: string }
  ): Promise<unknown>;
  authorizeAndReserve?(
    input: {
      entitlement_id: string;
      reservation_id: string;
      run_id: string;
      task_id: string;
      units: number;
    },
    options: { idempotencyKey: string }
  ): Promise<unknown>;
  releaseReservation?(
    input: { reservation_id: string; reason: string },
    options: { idempotencyKey: string }
  ): Promise<unknown>;
  completeDelivery?(
    input: {
      reservation_id: string;
      task_id: string;
      artifact_id: string;
      delivery_id: string;
      artifact_type: "file" | "message";
      effective_corpus_digest: string;
    },
    options: { idempotencyKey: string }
  ): Promise<unknown>;
}

export type DeliveryBinding = {
  entitlementId: string;
  orderId: string;
  userId: string;
  creatorId: string;
  agentId: string;
  productId: string;
  /** Purchase snapshot; older local callers fall back to the effective digest. */
  purchasedCorpusDigest?: string;
  corpusDigest: string;
};

export type DeliveryReceipt = {
  task_id: string;
  artifact_id: string;
  artifact_digest: string;
  delivery_id: string;
  artifact_type: "file" | "message";
};

export type DeliveryArtifact = {
  content: string;
  type: "file" | "message";
};

export type DeliveryUnitReservation = {
  reservationId: string;
  taskId: string;
  deliveryId: string;
};

export function stableTaskId(binding: DeliveryBinding, conversationId: string, runId: string): string {
  return `task_${shortHash([binding.entitlementId, conversationId, runId].join("\u0000"))}`;
}

export function prepareDelivery(
  binding: DeliveryBinding,
  conversationId: string,
  runId: string,
  artifact: DeliveryArtifact
): DeliveryReceipt {
  return deliveryReceiptFromMetadata(binding, conversationId, runId, {
    type: artifact.type,
    digest: digest(artifact.content)
  });
}

export function deliveryReceiptFromMetadata(
  binding: DeliveryBinding,
  conversationId: string,
  runId: string,
  artifact: { type: "file" | "message"; digest: string }
): DeliveryReceipt {
  const taskId = stableTaskId(binding, conversationId, runId);
  return {
    task_id: taskId,
    artifact_id: `artifact_${shortHash(taskId)}`,
    artifact_digest: artifact.digest,
    delivery_id: `delivery_${shortHash(taskId)}`,
    artifact_type: artifact.type
  };
}

export async function findCompletedDelivery(
  sink: CommerceEventSink,
  binding: DeliveryBinding,
  conversationId: string,
  runId: string
): Promise<DeliveryReceipt | undefined> {
  if (!sink.findByIdempotencyKey) return undefined;
  const taskId = stableTaskId(binding, conversationId, runId);
  const artifactId = `artifact_${shortHash(taskId)}`;
  const deliveryId = `delivery_${shortHash(taskId)}`;
  const deliveryIdempotencyKey = `delivery:${deliveryId}:completed`;
  // CommerceService appends the atomic delivery mutation with a `:delivery`
  // suffix. Keep reading the legacy sink key too so old ledgers remain valid.
  const existingDelivery = await sink.findByIdempotencyKey(deliveryIdempotencyKey)
    ?? await sink.findByIdempotencyKey(`${deliveryIdempotencyKey}:delivery`);
  const existingArtifact = await sink.findByIdempotencyKey(`artifact:${artifactId}:created`);
  if (!isRecordedEvent(existingDelivery) || !isRecordedEvent(existingArtifact)) return undefined;
  const recordedDigest = existingArtifact.artifact_digest;
  if (typeof recordedDigest !== "string") throw new Error(`Recorded artifact ${artifactId} has no digest`);
  const recordedType = existingArtifact.artifact_type;
  return {
    task_id: taskId,
    artifact_id: artifactId,
    artifact_digest: recordedDigest,
    delivery_id: deliveryId,
    artifact_type: recordedType === "file" ? "file" : "message"
  };
}

/**
 * Reserves one delivery unit before the Runtime starts entitlement-backed
 * work. A sink that only implements the legacy append contract deliberately
 * returns undefined and continues to work as it did before Commerce V2.
 */
export async function reserveDeliveryUnit(
  sink: CommerceEventSink,
  binding: DeliveryBinding,
  conversationId: string,
  runId: string
): Promise<DeliveryUnitReservation | undefined> {
  if (!hasDeliveryUnitLifecycle(sink)) return undefined;
  const taskId = stableTaskId(binding, conversationId, runId);
  const deliveryId = `delivery_${shortHash(taskId)}`;
  const reservationId = `reservation_${shortHash(taskId)}`;
  await sink.authorizeAndReserve({
    entitlement_id: binding.entitlementId,
    reservation_id: reservationId,
    run_id: runId,
    task_id: taskId,
    units: 1
  }, { idempotencyKey: `delivery:${deliveryId}:authorize` });
  return { reservationId, taskId, deliveryId };
}

export async function releaseDeliveryUnit(
  sink: CommerceEventSink,
  reservation: DeliveryUnitReservation,
  reason: "run_failed" | "run_cancelled" | "delivery_not_completed"
): Promise<void> {
  if (!hasDeliveryUnitLifecycle(sink)) return;
  await sink.releaseReservation({
    reservation_id: reservation.reservationId,
    reason
  }, { idempotencyKey: `delivery:${reservation.deliveryId}:release` });
}

export async function recordCompletedDelivery(
  sink: CommerceEventSink,
  binding: DeliveryBinding,
  conversationId: string,
  runId: string,
  artifact: DeliveryArtifact,
  reservation?: DeliveryUnitReservation
): Promise<DeliveryReceipt> {
  return recordPreparedDelivery(
    sink,
    binding,
    conversationId,
    runId,
    prepareDelivery(binding, conversationId, runId, artifact),
    reservation
  );
}

/** Replays a safe, pre-digested command without retaining artifact content. */
export async function recordPreparedDelivery(
  sink: CommerceEventSink,
  binding: DeliveryBinding,
  conversationId: string,
  runId: string,
  receipt: DeliveryReceipt,
  reservation?: DeliveryUnitReservation
): Promise<DeliveryReceipt> {
  const taskId = stableTaskId(binding, conversationId, runId);
  const artifactId = `artifact_${shortHash(taskId)}`;
  const deliveryId = `delivery_${shortHash(taskId)}`;
  if (receipt.task_id !== taskId
    || receipt.artifact_id !== artifactId
    || receipt.delivery_id !== deliveryId
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.artifact_digest)) {
    throw new Error("Prepared delivery does not match the Runtime run identity");
  }
  const existing = await findCompletedDelivery(sink, binding, conversationId, runId);
  if (existing) return existing;
  const common = {
    order_id: binding.orderId,
    buyer_id: binding.userId,
    creator_id: binding.creatorId,
    agent_id: binding.agentId,
    product_id: binding.productId,
    corpus_digest: binding.purchasedCorpusDigest ?? binding.corpusDigest,
    purchased_corpus_digest: binding.purchasedCorpusDigest ?? binding.corpusDigest,
    effective_corpus_digest: binding.corpusDigest
  };

  await sink.append("task.started", {
    task_id: taskId,
    entitlement_id: binding.entitlementId,
    ...common
  }, { idempotencyKey: `task:${taskId}:started` });
  await sink.append("artifact.created", {
    artifact_id: artifactId,
    task_id: taskId,
    artifact_digest: receipt.artifact_digest,
    artifact_type: receipt.artifact_type,
    ...common
  }, { idempotencyKey: `artifact:${artifactId}:created` });
  if (reservation && hasDeliveryUnitLifecycle(sink)) {
    if (reservation.taskId !== taskId || reservation.deliveryId !== deliveryId) {
      throw new Error("Delivery reservation does not match the Runtime task");
    }
    await sink.completeDelivery({
      reservation_id: reservation.reservationId,
      task_id: taskId,
      artifact_id: artifactId,
      delivery_id: deliveryId,
      artifact_type: receipt.artifact_type,
      effective_corpus_digest: binding.corpusDigest
    }, { idempotencyKey: `delivery:${deliveryId}:completed` });
  } else {
    await sink.append("delivery.completed", {
      delivery_id: deliveryId,
      artifact_id: artifactId,
      task_id: taskId,
      entitlement_id: binding.entitlementId,
      ...common
    }, { idempotencyKey: `delivery:${deliveryId}:completed` });
  }

  return receipt;
}

function hasDeliveryUnitLifecycle(sink: CommerceEventSink): sink is CommerceEventSink & Required<Pick<
  CommerceEventSink,
  "authorizeAndReserve" | "releaseReservation" | "completeDelivery"
>> {
  return typeof sink.authorizeAndReserve === "function"
    && typeof sink.releaseReservation === "function"
    && typeof sink.completeDelivery === "function";
}

function isRecordedEvent(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
