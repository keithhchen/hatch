import { randomUUID } from "node:crypto";
import { HatchError } from "./errors.js";

// A request handler is `async ({method, path, headers, body}) => response`.
// Decorators are higher-order: handler => handler.
export const compose = (...decorators) => (core) => decorators.reduceRight((next, d) => d(next), core);

export const withAuth = (tokenOf) => (next) => async (req) => {
  const token = tokenOf();
  if (!token) throw new HatchError("Not signed in. Run `hatch login`.", { code: "not_signed_in" });
  return next({ ...req, headers: { ...req.headers, authorization: `Bearer ${token}` } });
};

export const withIdempotency = (next) => async (req) =>
  next(req.method === "GET" ? req : { ...req, headers: { "idempotency-key": randomUUID(), ...req.headers } });

export const withJson = (next) => async (req) => {
  const hasBody = req.body !== undefined;
  const res = await next({
    ...req,
    headers: { accept: "application/json", ...(hasBody ? { "content-type": "application/json" } : {}), ...req.headers },
    body: hasBody ? JSON.stringify(req.body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, data };
};

const messageOf = (data) => data?.error?.message ?? data?.detail ?? data?.message ?? null;

const networkError = (baseUrl, error) =>
  error instanceof HatchError ? error : new HatchError(`Cannot reach ${baseUrl}: ${error.cause?.code ?? error.message}`, { code: "network" });

const statusError = ({ status, data }) => {
  const detail = messageOf(data);
  if (status === 401) return new HatchError("Not signed in, or the token was rejected or expired. Run `hatch login`.", { code: "unauthorized", status });
  if (status === 403) return new HatchError(`Forbidden${detail ? `: ${detail}` : ""}`, { code: "forbidden", status });
  if (status === 404) return new HatchError(`Not found${detail ? `: ${detail}` : ""}`, { code: "not_found", status });
  return new HatchError(`Request failed (${status})${detail ? `: ${detail}` : ""}`, { code: data?.error?.code ?? "http_error", status });
};

export const withErrors = (baseUrl) => (next) => async (req) => {
  let result;
  try { result = await next(req); } catch (error) { throw networkError(baseUrl, error); }
  if (result.ok) return result.data;
  throw statusError(result);
};

// Streaming: the answer is the body as an async iterable of bytes. Reading it can still fail mid-way.
export const withSse = (next) => (req) => next({
  ...req,
  headers: { accept: "text/event-stream", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...req.headers },
  body: req.body === undefined ? undefined : JSON.stringify(req.body)
});

export const withStreamErrors = (baseUrl) => (next) => async (req) => {
  let res;
  try { res = await next(req); } catch (error) { throw networkError(baseUrl, error); }
  if (res.ok) return res.body;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 200) }; }
  throw statusError({ status: res.status, data });
};

export class HatchClient {
  constructor(handler, streamHandler) { this.handler = handler; this.streamHandler = streamHandler; }

  // token: string | null. authenticated=false skips the Authorization header.
  static create({ baseUrl, fetch: fetchFn = globalThis.fetch, token = null, authenticated = true }) {
    const root = baseUrl.replace(/\/+$/, "");
    const core = ({ method, path, headers, body }) => fetchFn(root + path, { method, headers, body });
    const handler = compose(
      withErrors(root), withJson, withIdempotency, ...(authenticated ? [withAuth(() => token)] : [])
    )(core);
    const auth = authenticated ? [withAuth(() => token)] : [];
    return new HatchClient(handler, compose(withStreamErrors(root), withSse, ...auth)(core));
  }

  request(method, path, body, headers = {}) { return this.handler({ method, path, headers, body }); }
  stream(method, path, body, headers = {}) { return this.streamHandler({ method, path, headers, body }); }
  get(path) { return this.request("GET", path); }
  post(path, body, headers) { return this.request("POST", path, body, headers); }
  put(path, body) { return this.request("PUT", path, body); }
  patch(path, body) { return this.request("PATCH", path, body); }
  delete(path) { return this.request("DELETE", path); }
}
