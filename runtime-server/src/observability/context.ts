import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

/** The ids one request carries through every layer. Each is optional until the layer that learns it binds it. */
export type RequestContext = { request_id: string; account_id?: string; conversation_id?: string; run_id?: string };

const storage = new AsyncLocalStorage<RequestContext>();

export const newRequestId = (): string => `req_${randomBytes(8).toString("hex")}`;

/** A caller-supplied id is only trusted when it is short and plain; anything else is replaced. */
export function requestIdFrom(value: string | string[] | undefined): string {
  const candidate = String(Array.isArray(value) ? value[0] : value ?? "").trim();
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(candidate) ? candidate : newRequestId();
}

export const currentContext = (): RequestContext | undefined => storage.getStore();

export const runInContext = <T>(context: RequestContext, work: () => T): T => storage.run({ ...context }, work);

/** Adds ids to the request in flight; a no-op outside one. */
export function bindContext(ids: Partial<Omit<RequestContext, "request_id">>): void {
  const store = storage.getStore();
  if (store) for (const [key, value] of Object.entries(ids)) if (value) (store as Record<string, string>)[key] = value;
}
