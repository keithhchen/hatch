export type Fetch = typeof fetch;

/** A non-2xx answer. The message carries the status and the API's own text, never a credential. */
export class KimiApiError extends Error {
  constructor(readonly status: number, message: string) { super(`Kimi API ${status}: ${message}`); }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Adds headers to every request. */
export const withHeaders = (inner: Fetch, headers: Record<string, string>): Fetch =>
  (input, init) => inner(input, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) } });

/** Resolves a relative path against a base URL. */
export const withBase = (inner: Fetch, baseUrl: string): Fetch =>
  (input, init) => inner(`${baseUrl.replace(/\/+$/, "")}${input}`, init);

/** Sends again once after a short pause when the API says 429 or 5xx. */
export const withRetry = (inner: Fetch, delayMs: number): Fetch => async (input, init) => {
  const first = await inner(input, init);
  if (first.status !== 429 && first.status < 500) return first;
  await first.body?.cancel();
  await sleep(delayMs);
  return inner(input, init);
};

/** Turns any non-2xx response into a KimiApiError. */
export const withErrors = (inner: Fetch): Fetch => async (input, init) => {
  const response = await inner(input, init);
  if (response.ok) return response;
  const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } } | undefined;
  throw new KimiApiError(response.status, body?.error?.message ?? response.statusText);
};

export type RequestOptions = { query?: Record<string, string | number | undefined>; json?: unknown; form?: FormData; headers?: Record<string, string>; signal?: AbortSignal };
export type Send = (method: string, path: string, options?: RequestOptions) => Promise<Response>;

/** The one place a request is built: query string, JSON or multipart body. */
export const sender = (fetchImpl: Fetch): Send => (method, path, { query = {}, json, form, headers, signal } = {}) => {
  const search = new URLSearchParams(Object.entries(query).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]])));
  const url = search.size ? `${path}?${search}` : path;
  return fetchImpl(url, {
    method,
    signal,
    headers: { ...(json === undefined ? {} : { "content-type": "application/json" }), ...headers },
    body: form ?? (json === undefined ? undefined : JSON.stringify(json)),
  });
};

/** Wraps a sender so it returns parsed JSON (undefined for an empty body). */
export const asJson = (send: Send) => async <T>(method: string, path: string, options?: RequestOptions): Promise<T> => {
  const text = await (await send(method, path, options)).text();
  return (text ? JSON.parse(text) : undefined) as T;
};

type Page<T> = { items: T[]; next_page_token?: string };

/** Walks every item of a token-paginated list. */
export async function* paginate<T>(list: (pageToken?: string) => Promise<Page<T>>): AsyncGenerator<T> {
  let token: string | undefined;
  do {
    const page = await list(token);
    yield* page.items;
    token = page.next_page_token;
  } while (token);
}

/** First item of a paginated list that satisfies `match`. */
export async function findFirst<T>(list: (pageToken?: string) => Promise<Page<T>>, match: (item: T) => boolean): Promise<T | undefined> {
  for await (const item of paginate(list)) if (match(item)) return item;
  return undefined;
}
