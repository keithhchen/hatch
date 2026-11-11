import { createHmac } from "node:crypto";

/** Test support only: a fetch that records each request and answers it, so no test touches a network. */
export type Call = { url: string; init: RequestInit; body: any };

export function recorder(respond: (url: string, init: RequestInit) => Response | Promise<Response> = () => new Response("{}")) {
  const calls: Call[] = [];
  const fake = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body });
    return respond(String(url), init);
  }) as typeof fetch;
  return { calls, fake };
}

export const sign = (body: string | Buffer, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
export const graphError = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) => new Response(JSON.stringify({ error }), { status, headers });
