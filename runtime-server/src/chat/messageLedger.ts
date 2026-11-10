import type { ConversationMessage } from "../protocol.js";
import type { ConversationJournalEvent } from "../conversationRepository.js";

/**
 * The journal is the message ledger. A user message is one `message.created`
 * event keyed by client_message_id; the database makes that key unique, so a
 * retry can never become a second message. A steered message waits in the
 * ledger until its Run claims it.
 */
export type LedgerEntry = {
  clientMessageId: string;
  digest?: string;
  steered: boolean;
  runId?: string;
  message?: ConversationMessage;
  acceptedAt: string;
};

export const ledgerEntry = (event: ConversationJournalEvent): LedgerEntry | undefined => {
  const payload = event.payload;
  if (event.type !== "message.created" || payload.role !== "user" || typeof payload.client_message_id !== "string") return undefined;
  return {
    clientMessageId: payload.client_message_id,
    ...(typeof payload.input_digest === "string" ? { digest: payload.input_digest } : {}),
    steered: payload.steered === true,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(payload.message ? { message: payload.message as ConversationMessage } : {}),
    acceptedAt: event.createdAt
  };
};

/** The steered message as the ledger keeps it, pixels included: the claim hands the Run exactly this message. */
export const steeredPayload = (clientMessageId: string, digest: string, message: ConversationMessage): Record<string, unknown> =>
  ({ role: "user", client_message_id: clientMessageId, input_digest: digest, steered: true, message });

/** What a journal event shows a client: a steered message's pixels stay on the server, its text and image labels go out. */
export const publicJournalPayload = (payload: Record<string, unknown>): Record<string, unknown> => {
  const message = payload.message as ConversationMessage | undefined;
  if (!message?.model_images) return payload;
  const { model_images: _pixels, ...shown } = message;
  return { ...payload, message: shown };
};

export type ClaimedMessage = { clientMessageId: string; message: ConversationMessage };
