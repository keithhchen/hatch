import { ZodError } from "zod";
import { BriefValidationError } from "../brief.js";
import { ChatError } from "../chat/principal.js";
import { ConversationRepositoryError } from "../conversationRepository.js";
import { ConversationError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";
import { resetDay, USAGE_CAP_EXCEEDED, UsageCapExceeded } from "../usage/usageCap.js";

export type ErrorType =
  | "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "conflict_error"
  | "rate_limit_error" | "insufficient_quota" | "server_error" | "service_unavailable";

/** A failure told the OpenAI way: `{ error: { message, type, param, code } }`. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly code: string,
    message: string,
    readonly param: string | null = null,
    /** Sent as `retry-after` (429, 503). */
    readonly retryAfterSeconds?: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const invalidRequest = (code: string, message: string, param: string | null = null): ApiError =>
  new ApiError(400, "invalid_request_error", code, message, param);
export const unsupported = (param: string, message = `${param} is not supported by this API.`): ApiError =>
  invalidRequest("unsupported_parameter", message, param);
export const notFound = (code: string, message: string): ApiError => new ApiError(404, "not_found_error", code, message);
export const conflict = (code: string, message: string): ApiError => new ApiError(409, "conflict_error", code, message);
export const invalidApiKey = (message = "Incorrect or missing API key. Send your Hatch API key as `Authorization: Bearer <key>`."): ApiError =>
  new ApiError(401, "authentication_error", "invalid_api_key", message);
export const unavailable = (message: string, retryAfterSeconds = 5): ApiError =>
  new ApiError(503, "service_unavailable", "service_unavailable", message, null, retryAfterSeconds);

const INTERNAL = "The server had an error processing your request.";
const UNAVAILABLE_CODES = new Set(["auth_registry_unavailable", "auth_registry_invalid", "entitlement_registry_unavailable", "authorization_unavailable", "authorization_cancelled", "access_service_unavailable", "access_service_invalid", "agent_corpus_unavailable"]);
const UNAUTHENTICATED_CODES = new Set(["authentication_required", "auth_invalid"]);

/** The chat domain's codes, as a client of this API knows them. A code not listed keeps its own name. */
const CHAT_CODES: Record<string, { status: number; type: ErrorType; code: string; retryAfter?: number }> = {
  conversation_busy: { status: 409, type: "conflict_error", code: "conversation_busy" },
  conversation_archived: { status: 409, type: "conflict_error", code: "conversation_archived" },
  client_message_conflict: { status: 409, type: "conflict_error", code: "idempotency_key_reused" },
  run_not_retryable: { status: 409, type: "conflict_error", code: "conversation_busy" },
  conversation_not_found: { status: 404, type: "not_found_error", code: "conversation_not_found" },
  conversation_binding_mismatch: { status: 404, type: "not_found_error", code: "conversation_not_found" },
  run_not_found: { status: 404, type: "not_found_error", code: "response_not_found" },
  product_requires_local_tools: { status: 400, type: "invalid_request_error", code: "model_requires_local_tools" },
  conversation_brief_required: { status: 400, type: "invalid_request_error", code: "task_brief_required" },
  too_large: { status: 413, type: "invalid_request_error", code: "file_too_large" },
  unsupported_type: { status: 415, type: "invalid_request_error", code: "unsupported_file_type" },
  runtime_run_capacity: { status: 503, type: "service_unavailable", code: "service_unavailable", retryAfter: 5 },
  [USAGE_CAP_EXCEEDED]: { status: 429, type: "insufficient_quota", code: USAGE_CAP_EXCEEDED },
  user_run_capacity: { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", retryAfter: 2 },
  authorization_busy: { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", retryAfter: 2 },
  user_authorization_busy: { status: 429, type: "rate_limit_error", code: "rate_limit_exceeded", retryAfter: 2 }
};

function fromCode(code: string, status: number, message: string): ApiError | undefined {
  const known = CHAT_CODES[code];
  if (known) return new ApiError(known.status, known.type, known.code, message, null, known.retryAfter);
  if (status >= 400 && status < 500) return new ApiError(status, status === 404 ? "not_found_error" : status === 403 ? "permission_error" : "invalid_request_error", code, message);
  return undefined;
}

/** What the adapter makes of any failure: the OpenAI-shaped error and whether it was unexpected (the caller logs those with the request id). */
export function toApiError(error: unknown): { error: ApiError; internal: boolean } {
  if (error instanceof ApiError) return { error, internal: false };
  if (error instanceof UsageCapExceeded) {
    return { error: new ApiError(429, "insufficient_quota", USAGE_CAP_EXCEEDED, `Monthly token limit reached (${error.used}/${error.cap}). It resets on ${resetDay(error.resetsAt)}.`), internal: false };
  }
  if (error instanceof ChatError) {
    const mapped = fromCode(error.code, error.status, error.message);
    if (mapped) return { error: mapped, internal: false };
    if (error.status === 503) return { error: unavailable(error.message), internal: false };
  } else if (error instanceof ConversationRepositoryError) {
    const mapped = fromCode(error.code, 400, error.message);
    if (mapped) return { error: mapped, internal: false };
  } else if (error instanceof BriefValidationError) {
    return { error: invalidRequest(error.code === "brief_required_answer_missing" ? "task_brief_required" : "invalid_task_brief", error.message, "task_brief"), internal: false };
  } else if (error instanceof EntitlementError) {
    if (UNAVAILABLE_CODES.has(error.code)) return { error: unavailable("Hatch could not verify access right now. Try again shortly."), internal: false };
    if (UNAUTHENTICATED_CODES.has(error.code)) return { error: invalidApiKey("The API key is no longer valid."), internal: false };
    return { error: new ApiError(403, "permission_error", "access_denied", "This account may not use this model."), internal: false };
  } else if (error instanceof ConversationError) {
    const mapped = fromCode(error.code, error.status, error.message);
    if (mapped) return { error: mapped, internal: false };
  } else if (error instanceof ZodError) {
    return { error: invalidRequest("invalid_request", error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; ")), internal: false };
  } else if (error instanceof URIError) {
    return { error: invalidRequest("invalid_request", "The request path contains invalid encoding."), internal: false };
  }
  return { error: new ApiError(500, "server_error", "internal_error", INTERNAL), internal: true };
}

export const errorBody = (error: ApiError): { error: { message: string; type: ErrorType; param: string | null; code: string } } =>
  ({ error: { message: error.message, type: error.type, param: error.param, code: error.code } });
