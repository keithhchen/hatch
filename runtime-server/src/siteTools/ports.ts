/** A research call failed or was refused: told back to the model as is, never replaced by invented results. */
export class SiteToolError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SiteToolError"; }
}

export type SiteResult = Record<string, unknown>;

/** One lookup on the outside world, run by the Runtime: its own key, never given to a box. */
export interface SiteLookup<Args> {
  run(args: Args, signal?: AbortSignal): Promise<SiteResult>;
}

export type Fetch = typeof fetch;

/** JSON over HTTP with a deadline; a non-2xx answer becomes a SiteToolError carrying the service's own message (never the request URL, which may hold a key). */
export async function callJson(fetcher: Fetch, url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs);
  let response: Response;
  try {
    response = await fetcher(url, { ...init, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  } catch (error) {
    signal?.throwIfAborted();
    throw new SiteToolError("unavailable", deadline.aborted ? `The service did not answer within ${timeoutMs / 1000} seconds.` : "The service could not be reached.");
  }
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = undefined; }
  if (!response.ok) {
    const record = body as { error?: { message?: string } | string; errors?: Array<{ message?: string }> } | undefined;
    const message = (typeof record?.error === "string" ? record.error : record?.error?.message) ?? record?.errors?.[0]?.message ?? text.slice(0, 200);
    throw new SiteToolError(`http_${response.status}`, `The service answered ${response.status}: ${message}`);
  }
  return body;
}

export const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || !value.trim()) throw new SiteToolError("invalid_call", `${name} is a non-empty string.`);
  return value.trim();
};
