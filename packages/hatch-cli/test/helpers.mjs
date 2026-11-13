import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { FileCredentialStore } from "../src/credentialStore.js";
import { HatchContext } from "../src/context.js";

export const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// routes: { "GET /v1/auth/me": (req) => Response | body }
export function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const path = new URL(url).pathname;
    const key = `${init.method ?? "GET"} ${path}`;
    const call = { key, url, headers: init.headers ?? {}, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body };
    calls.push(call);
    const handler = routes[key];
    if (!handler) return json({ error: { message: `no route ${key}` } }, 404);
    const out = typeof handler === "function" ? await handler(call) : handler;
    return out instanceof Response ? out : json(out);
  };
  fn.calls = calls;
  return fn;
}

export function sink() {
  const s = new PassThrough();
  let text = "";
  s.on("data", (c) => { text += c; });
  return Object.assign(s, { text: () => text });
}

export async function makeContext({ routes = {}, env = {}, ...rest } = {}) {
  const home = await mkdtemp(join(tmpdir(), "hatch-test-"));
  const fetch = fakeFetch(routes);
  const ctx = new HatchContext({
    env, fetch, home, cwd: home, store: FileCredentialStore.atHome(home),
    browser: { open() {} }, stdin: new PassThrough(), stdout: sink(), stderr: sink(), sleep: async () => {}, ...rest
  });
  return { ctx, fetch, home };
}

export const ME = { account: { id: "a1", email: "k@example.com", display_name: "Keith" } };
