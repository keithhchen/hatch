import type { ConversationRunRecord } from "../conversationRepository.js";

/** A Run as the REST API shows it. A Run that did not complete carries its failure, `{code, message, reference}`, as every client sees it. */
export function publicRun(run: ConversationRunRecord): Record<string, unknown> {
  return {
    id: run.id,
    client_message_id: run.clientMessageId,
    ...(run.inputDigest ? { input_digest: run.inputDigest } : {}),
    status: run.status,
    corpus_digest: run.corpusDigest,
    created_at: run.createdAt,
    ...(run.startedAt ? { started_at: run.startedAt } : {}),
    ...(run.completedAt ? { completed_at: run.completedAt } : {}),
    ...(run.failure ? { failure: run.failure } : {}),
    steered_messages: run.steeredCount,
    ...(run.partialOutput ? { partial_output: run.partialOutput } : {})
  };
}
