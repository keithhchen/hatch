import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { bindAccount, observed, propagatingFetch } from "../observability.mjs";

async function serve(handler, write) {
  const server = createServer(observed(handler, write));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("the incoming request id is kept, forwarded on outbound calls, echoed, and logged in one access line", async () => {
  const lines = [];
  const forwarded = [];
  const outbound = propagatingFetch(async (_url, init) => { forwarded.push(new Headers(init.headers).get("x-request-id")); return new Response("ok"); });
  const app = await serve(async (_request, response) => {
    bindAccount("acct_1");
    await outbound("http://registry.local/v1/auth/me", { headers: { authorization: "Bearer x" } });
    response.end("done");
  }, (level, line) => lines.push(JSON.parse(line)));
  try {
    const response = await fetch(`${app.url}/v1/thing?secret=1`, { headers: { "x-request-id": "req_from_caddy" } });
    await response.text();
    assert.equal(response.headers.get("x-request-id"), "req_from_caddy");
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally { await app.close(); }
  assert.deepEqual(forwarded, ["req_from_caddy"]);
  assert.equal(lines.length, 1);
  assert.deepEqual({ ...lines[0], ts: undefined, duration_ms: typeof lines[0].duration_ms }, {
    ts: undefined, level: "info", event: "access", service: "dashboard", request_id: "req_from_caddy", account_id: "acct_1",
    method: "GET", path: "/v1/thing", status: 200, duration_ms: "number"
  });
});

test("a request without a usable id gets a minted one; a call outside any request is left alone", async () => {
  const app = await serve((_request, response) => response.end("x"), () => undefined);
  try {
    const response = await fetch(app.url, { headers: { "x-request-id": "bad id with spaces" } });
    assert.match(response.headers.get("x-request-id"), /^req_[0-9a-f]{16}$/);
  } finally { await app.close(); }
  const seen = [];
  await propagatingFetch(async (_url, init) => { seen.push(init); return new Response(""); })("http://x.local", undefined);
  assert.deepEqual(seen, [undefined]);
});
