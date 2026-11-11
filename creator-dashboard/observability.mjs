import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

// The dashboard is its own package, so it carries its own small copy of the runtime-server request context:
// same `x-request-id` contract, same one-line JSON access log, same `service` field.
const storage = new AsyncLocalStorage();

export const newRequestId = () => `req_${randomBytes(8).toString("hex")}`;

export function requestIdFrom(value) {
  const candidate = String(Array.isArray(value) ? value[0] : value ?? "").trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) ? candidate : newRequestId();
}

export const currentContext = () => storage.getStore();

/** Adds the account to the request in flight; a no-op outside one. */
export function bindAccount(accountId) {
  const store = storage.getStore();
  if (store && accountId) store.account_id = accountId;
}

export function logEvent(level, event, fields = {}, write = defaultWrite) {
  write(level, JSON.stringify({ ts: new Date().toISOString(), level, event, service: "dashboard", ...currentContext(), ...fields }));
}

const defaultWrite = (level, line) => (level === "error" || level === "warn" ? console.error : console.log)(line);

/** Wraps a request handler: runs it inside its context, echoes the id, and ends in one access line. */
export function observed(handler, write = defaultWrite) {
  return (request, response) => {
    const context = { request_id: requestIdFrom(request.headers["x-request-id"]) };
    const started = process.hrtime.bigint();
    const path = (request.url ?? "").split("?")[0];
    response.setHeader("x-request-id", context.request_id);
    return storage.run(context, () => {
      response.once("close", () => logEvent("info", "access", {
        method: request.method, path, status: response.statusCode,
        duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100
      }, write));
      return handler(request, response);
    });
  };
}

/** Wraps a fetch so a call made inside a request carries its id; other calls pass through unchanged. */
export function propagatingFetch(inner) {
  return (input, init) => {
    const id = currentContext()?.request_id;
    if (!id) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-request-id")) headers.set("x-request-id", id);
    return inner(input, { ...init, headers });
  };
}
