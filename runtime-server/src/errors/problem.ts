import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";

/** How any failure is told to a client. `internal` marks a failure nobody anticipated: the adapter logs the real error. */
export type Problem = { status: number; code: string; message: string; details?: unknown; internal?: true };

const UNAVAILABLE = new Set(["auth_registry_unavailable", "auth_registry_invalid", "entitlement_registry_unavailable", "authorization_unavailable", "authorization_cancelled"]);
const DENIED = new Set(["authentication_required", "auth_invalid", "entitlement_required", "entitlement_not_found", "agent_entitlement_mismatch"]);

/** The status of a repository refusal on the Conversation HTTP routes. */
export const repositoryStatus = (code: string): number =>
  code === "conversation_not_found" || code === "run_not_found" ? 404
    : code === "conversation_busy" || code === "version_conflict" ? 409
      : code === "conversation_binding_mismatch" ? 403 : 400;

/** The status of a repository refusal raised while a message or retry is admitted (ChatService). */
export const admissionStatus = (code: string): number =>
  ["client_message_conflict", "conversation_archived", "conversation_busy", "run_not_retryable"].includes(code) ? 409 : 400;

/**
 * The Conversation HTTP routes' mapping from a failure to a status, a stable code and a message that is safe to show.
 * An unknown error is a 500 whose text never reaches a client.
 */
export function toProblem(error: unknown): Problem {
  if (error instanceof ConversationError) return { status: error.status, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  if (error instanceof ChatError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof BriefValidationError) return { status: 422, code: error.code, message: error.message };
  if (error instanceof EntitlementError) {
    if (UNAVAILABLE.has(error.code)) return { status: 503, code: "authorization_unavailable", message: "Hatch could not verify access right now. Try again shortly." };
    if (DENIED.has(error.code)) return { status: 403, code: "entitlement_required", message: "This Expert Agent is not available for the signed-in account." };
    return { status: 500, code: "internal_error", message: "The Runtime could not complete this request.", internal: true };
  }
  if (error instanceof ConversationRepositoryError) return { status: repositoryStatus(error.code), code: error.code, message: error.message };
  if (error instanceof RangeError) return { status: 400, code: "invalid_request", message: error.message };
  if (error && typeof error === "object" && "code" in error && error.code === "history_cursor_invalid") {
    return { status: 400, code: "history_cursor_invalid", message: "The history cursor does not belong to this conversation or is invalid." };
  }
  return { status: 500, code: "conversation_request_failed", message: "The Runtime could not complete this request.", internal: true };
}
