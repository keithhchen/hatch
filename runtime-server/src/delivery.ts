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
}

export type DeliveryBinding = {
  entitlementId: string;
  orderId: string;
  userId: string;
  creatorId: string;
  productId: string;
  releaseId: string;
  releaseDigest: string;
};

export type DeliveryReceipt = {
  task_id: string;
  artifact_id: string;
  artifact_digest: string;
  delivery_id: string;
  artifact_type: "file" | "message";
  artifact_path?: string;
};

export type DeliveryArtifact = {
  content: string;
  type: "file" | "message";
  path?: string;
};

export function stableTaskId(binding: DeliveryBinding, conversationId: string, runId: string): string {
  return `task_${shortHash([binding.entitlementId, conversationId, runId].join("\u0000"))}`;
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
  const existingDelivery = await sink.findByIdempotencyKey(`delivery:${deliveryId}:completed`);
  const existingArtifact = await sink.findByIdempotencyKey(`artifact:${artifactId}:created`);
  if (!isRecordedEvent(existingDelivery) || !isRecordedEvent(existingArtifact)) return undefined;
  const recordedDigest = existingArtifact.artifact_digest;
  if (typeof recordedDigest !== "string") throw new Error(`Recorded artifact ${artifactId} has no digest`);
  const recordedPath = existingArtifact.artifact_path;
  const recordedType = existingArtifact.artifact_type;
  return {
    task_id: taskId,
    artifact_id: artifactId,
    artifact_digest: recordedDigest,
    delivery_id: deliveryId,
    artifact_type: recordedType === "file" ? "file" : "message",
    ...(typeof recordedPath === "string" ? { artifact_path: recordedPath } : {})
  };
}

export async function recordCompletedDelivery(
  sink: CommerceEventSink,
  binding: DeliveryBinding,
  conversationId: string,
  runId: string,
  artifact: DeliveryArtifact
): Promise<DeliveryReceipt> {
  const taskId = stableTaskId(binding, conversationId, runId);
  const artifactId = `artifact_${shortHash(taskId)}`;
  const deliveryId = `delivery_${shortHash(taskId)}`;
  const existing = await findCompletedDelivery(sink, binding, conversationId, runId);
  if (existing) return existing;
  const artifactDigest = digest(artifact.content);
  const common = {
    order_id: binding.orderId,
    buyer_id: binding.userId,
    creator_id: binding.creatorId,
    product_id: binding.productId,
    release_id: binding.releaseId,
    release_digest: binding.releaseDigest
  };

  await sink.append("task.started", {
    task_id: taskId,
    entitlement_id: binding.entitlementId,
    ...common
  }, { idempotencyKey: `task:${taskId}:started` });
  await sink.append("artifact.created", {
    artifact_id: artifactId,
    task_id: taskId,
    artifact_digest: artifactDigest,
    artifact_type: artifact.type,
    ...(artifact.path ? { artifact_path: artifact.path } : {}),
    ...common
  }, { idempotencyKey: `artifact:${artifactId}:created` });
  await sink.append("delivery.completed", {
    delivery_id: deliveryId,
    artifact_id: artifactId,
    task_id: taskId,
    entitlement_id: binding.entitlementId,
    ...common
  }, { idempotencyKey: `delivery:${deliveryId}:completed` });

  return {
    task_id: taskId,
    artifact_id: artifactId,
    artifact_digest: artifactDigest,
    delivery_id: deliveryId,
    artifact_type: artifact.type,
    ...(artifact.path ? { artifact_path: artifact.path } : {})
  };
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
