import { createHash, randomBytes } from "node:crypto";
import type { ArtifactRef, QuestionBatchArtifactRef } from "./types.js";

const ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const BATCH_NONCE = /^[a-f0-9]{64}$/;
const BATCH_ID = /^qbatch_v1_[a-f0-9]{64}$/;
const DOMAIN = "hatch.creator-factory.question-batch.v1";

/**
 * Give a sealed Question artifact a fresh run-scoped transport identity.
 * The artifact SHA remains only an integrity checksum; it is never itself an
 * answer-authorization token.
 */
export function issueQuestionBatch(
  runId: string,
  artifact: ArtifactRef,
): QuestionBatchArtifactRef {
  if (!artifact.sealed) throw new Error("Question batch artifact must be sealed");
  const batchNonce = randomBytes(32).toString("hex");
  return {
    ...artifact,
    sealed: true,
    batchNonce,
    batchId: deriveQuestionBatchId(runId, artifact.sha256, batchNonce),
  };
}

export function deriveQuestionBatchId(
  runId: string,
  artifactSha256: string,
  batchNonce: string,
): string {
  if (!runId.trim()) throw new Error("Question batch run id is required");
  if (!ARTIFACT_DIGEST.test(artifactSha256)) throw new Error("Question batch artifact digest is invalid");
  if (!BATCH_NONCE.test(batchNonce)) throw new Error("Question batch nonce is invalid");
  const digest = createHash("sha256")
    .update(DOMAIN)
    .update("\0")
    .update(runId)
    .update("\0")
    .update(artifactSha256)
    .update("\0")
    .update(batchNonce)
    .digest("hex");
  return `qbatch_v1_${digest}`;
}

/** Validate the persisted nonce, run binding, artifact binding, and ID. */
export function requireQuestionBatchId(
  runId: string,
  reference: ArtifactRef | QuestionBatchArtifactRef | undefined,
): string {
  const candidate = reference as Partial<QuestionBatchArtifactRef> | undefined;
  if (
    !candidate?.sealed
    || typeof candidate.batchNonce !== "string"
    || typeof candidate.batchId !== "string"
    || !BATCH_ID.test(candidate.batchId)
  ) {
    throw new Error(`Factory run ${runId} has no valid run-scoped Question batch binding`);
  }
  const expected = deriveQuestionBatchId(runId, candidate.sha256 ?? "", candidate.batchNonce);
  if (candidate.batchId !== expected) {
    throw new Error(`Factory run ${runId} has an invalid run-scoped Question batch binding`);
  }
  return candidate.batchId;
}

export function isQuestionBatchId(value: string): boolean {
  return BATCH_ID.test(value);
}
