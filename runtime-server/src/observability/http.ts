import { SpanStatusCode, trace } from "@opentelemetry/api";
import type http from "node:http";
import { currentContext, requestIdFrom, runInContext } from "./context.js";
import { log as rootLog, type Log } from "./log.js";

type Handler = (request: http.IncomingMessage, response: http.ServerResponse) => void;

/**
 * Wraps a request handler: each request runs inside its context (id from `x-request-id`, or minted), the id is
 * echoed on the response, a span is opened, and the request ends in one access line.
 */
export function observed(handler: Handler, log: Log = rootLog): Handler {
  return (request, response) => {
    const requestId = requestIdFrom(request.headers["x-request-id"]);
    const started = process.hrtime.bigint();
    const path = request.url?.split("?")[0];
    response.setHeader("x-request-id", requestId);
    runInContext({ request_id: requestId }, () => {
      const span = trace.getTracer("hatch").startSpan(`${request.method} ${path}`, { attributes: { request_id: requestId } });
      const context = currentContext();
      response.once("close", () => {
        span.setAttribute("http.status_code", response.statusCode);
        if (response.statusCode >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        log.child({ request_id: requestId }).info("access", {
          method: request.method, path, status: response.statusCode,
          duration_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100,
          ...(context?.account_id ? { account_id: context.account_id } : {})
        });
      });
      handler(request, response);
    });
  };
}

/** Wraps a fetch so a call made inside a request carries its id; other calls pass through unchanged. */
export function propagatingFetch(inner: typeof fetch): typeof fetch {
  return (input, init) => {
    const id = currentContext()?.request_id;
    if (!id) return inner(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    if (!headers.has("x-request-id")) headers.set("x-request-id", id);
    return inner(input, { ...init, headers });
  };
}

/** Replaces the process's fetch once, so every call site propagates the id. */
export const installPropagatingFetch = (): void => { globalThis.fetch = propagatingFetch(globalThis.fetch); };
