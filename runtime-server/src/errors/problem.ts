import { ZodError } from "zod";
import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";

/** How any failure is told to a client, over any transport. `internal` marks a failure nobody anticipated: the adapter logs the real error. */
export type Problem = { status: number; code: string; message: string; details?: unknown; internal?: true };

/** State conflicts: the request was fine, the conversation is not in a state that takes it. */
const CONFLICTS = new Set(["client_message_conflict", "conversation_archived", "conversation_busy", "run_not_retryable", "version_conflict"]);
const NOT_FOUND = new Set(["conversation_not_found", "run_not_found"]);
const UNAVAILABLE = new Set(["auth_registry_unavailable", "auth_registry_invalid", "entitlement_registry_unavailable", "authorization_unavailable", "authorization_cancelled"]);

const repositoryStatus = (code: string): number =>
  NOT_FOUND.has(code) ? 404 : CONFLICTS.has(code) ? 409 : code === "conversation_binding_mismatch" ? 403 : 400;

/** The one mapping from a failure to a status, a stable code and a message that is safe to show. An unknown error is a 500 with a generic message; its text never reaches a client. */
export function toProblem(error: unknown): Problem {
  if (error instanceof ConversationError) return { status: error.status, code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) };
  if (error instanceof ChatError) return { status: error.status, code: error.code, message: error.message };
  if (error instanceof BriefValidationError) return { status: 422, code: error.code, message: error.message };
  if (error instanceof EntitlementError) {
    return UNAVAILABLE.has(error.code)
      ? { status: 503, code: "authorization_unavailable", message: "Hatch could not verify access right now. Try again shortly." }
      : { status: 403, code: "entitlement_required", message: "This Expert Agent is not available for the signed-in account." };
  }
  if (error instanceof ConversationRepositoryError) {
    return {
      status: repositoryStatus(error.code), code: error.code,
      message: error.code === "client_message_conflict" ? "This client_message_id was already used with different message or attachment content." : error.message
    };
  }
  if (error instanceof ZodError) return { status: 400, code: "invalid_request", message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ") };
  if (error instanceof RangeError) return { status: 400, code: "invalid_request", message: error.message };
  if (error && typeof error === "object" && "code" in error && error.code === "history_cursor_invalid") {
    return { status: 400, code: "history_cursor_invalid", message: "The history cursor does not belong to this conversation or is invalid." };
  }
  return { status: 500, code: "internal_error", message: "The Runtime could not complete this request.", internal: true };
}
