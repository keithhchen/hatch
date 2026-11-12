import type http from "node:http";
import { sessionTokenFromCookie } from "../chat/originPolicy.js";
import { ConversationError as ConversationHttpError } from "../conversations/conversation.js";
import { EntitlementError } from "../entitlements.js";
import { toProblem } from "../errors/problem.js";
import { log } from "../observability/log.js";

/** The longest a client may ask a request to wait for a Run's result. */
export const MAX_WAIT_SECONDS = 60;

/** Streams and `?wait=` polls bound themselves; everything else gets the request deadline. */
export function httpDeadlineMs(req: http.IncomingMessage, requestTimeoutMs: number): number | undefined {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (String(req.headers.accept ?? "").includes("text/event-stream")) return undefined;
  // The Responses API holds a request up to 90 s and streams on a plain Accept header: the API bounds itself.
  if (url.pathname.startsWith("/responses/v1/")) return undefined;
  const wait = Number(url.searchParams.get("wait") ?? 0);
  return requestTimeoutMs + (Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_WAIT_SECONDS) * 1000 : 0);
}

/** An API key or session token from Authorization; a browser may use its session cookie instead. */
export function bearerToken(req: http.IncomingMessage): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization !== "string") return sessionTokenFromCookie(req.headers.cookie);
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || undefined;
}

export function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("access-control-allow-headers", "authorization, content-type");
}

export function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

export function writeJsonBounded(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  maxBytes: number
): void {
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    writeJson(res, 413, {
      error: {
        code: "response_too_large",
        message: "The requested Runtime response exceeds the bounded response size."
      }
    });
    return;
  }
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(serialized, "utf8")
  });
  res.end(serialized);
}

export function handleHttpRequestFailure(res: http.ServerResponse, error: unknown): void {
  if (res.headersSent || res.writableEnded) {
    res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  try {
    if (error instanceof URIError) {
      writeJson(res, 400, {
        error: { code: "invalid_request_path", message: "The request path contains invalid encoding." }
      });
      return;
    }
    writeJson(res, 500, {
      error: { code: "internal_error", message: "The Runtime could not complete this request." }
    });
  } catch {
    res.destroy();
  }
}

export function writeHttpAuthorizationFailure(
  res: http.ServerResponse,
  error: unknown,
  forbiddenCode: string
): void {
  const code = error instanceof EntitlementError ? error.code : "";
  if (code === "auth_registry_unavailable"
    || code === "auth_registry_invalid"
    || code === "entitlement_registry_unavailable"
    || code === "authorization_unavailable"
    || code === "authorization_cancelled") {
    writeJson(res, 503, {
      error: {
        code: "authorization_unavailable",
        message: "Hatch could not verify access right now. Try again shortly."
      }
    });
    return;
  }
  if (code === "authentication_required"
    || code === "auth_invalid"
    || code === "entitlement_required"
    || code === "entitlement_not_found"
    || code === "agent_entitlement_mismatch") {
    writeJson(res, 403, {
      error: { code: forbiddenCode, message: "This Expert Agent is not available for the signed-in account." }
    });
    return;
  }
  writeJson(res, 500, {
    error: { code: "internal_error", message: "The Runtime could not complete this request." }
  });
}

export function writeConversationHttpError(req: http.IncomingMessage, res: http.ServerResponse, error: unknown): void {
  const { status, code, message, internal } = toProblem(error);
  if (internal) log.error("conversation_request_failed", { method: req.method, path: req.url?.split("?")[0], error });
  writeJson(res, status, { error: { code, message } });
}

export async function readBoundedBytes(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > maxBytes) throw new ConversationHttpError(413, "request_too_large", `A file is limited to ${maxBytes} bytes.`);
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += value.byteLength;
    if (total > 1_048_576) throw new ConversationHttpError(413, "request_too_large", "Conversation request body is limited to 1 MiB.");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ConversationHttpError(400, "invalid_json", "Request body must be JSON.");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ConversationHttpError(400, "invalid_json", "Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function valueString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") throw new ConversationHttpError(400, "invalid_request", `${field} must be a string.`);
  return value;
}

export function optionalString(body: Record<string, unknown>, field: string, maxLength: number): string | undefined {
  if (body[field] === undefined) return undefined;
  const value = valueString(body, field).trim();
  if (value.length === 0 || value.length > maxLength) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must contain 1 to ${maxLength} characters.`);
  }
  return value;
}

export function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = optionalString(body, field, maxLength);
  if (!value) throw new ConversationHttpError(400, "invalid_request", `${field} is required.`);
  return value;
}

export function positiveIntegerValue(value: unknown, field: string, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be a positive integer.`);
  }
  return value;
}

export function rejectUnknownFields(body: Record<string, unknown>, allowed: string[]): void {
  const unexpected = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    throw new ConversationHttpError(400, "invalid_request", `Unsupported field${unexpected.length > 1 ? "s" : ""}: ${unexpected.join(", ")}.`);
  }
}

export function parseConversationStatus(value: string | null): "active" | "archived" | undefined {
  if (value === null || value === "") return undefined;
  if (value === "active" || value === "archived") return value;
  throw new ConversationHttpError(400, "invalid_status", "status must be active or archived.");
}

export function parsePositiveInteger(value: string | null, field: string, max: number): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be an integer between 1 and ${max}.`);
  }
  return parsed;
}

export function parseNonNegativeInteger(value: string | null, field: string): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new ConversationHttpError(400, "invalid_request", `${field} must be a non-negative integer.`);
  }
  return parsed;
}
