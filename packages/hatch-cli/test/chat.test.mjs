import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { main } from "../src/cli.js";
import { COMMANDS } from "../src/commands.js";
import { McpServer } from "../src/mcp.js";
import { CommandRegistry } from "../src/registry.js";
import { RunObserver, parseSse, resumable } from "../src/run.js";
import { makeContext, sink } from "./helpers.mjs";

// These tests prove the client's behaviour against a local HTTP server. They are not end-to-end product evidence.
const sse = (events) => events.map(([id, event, data]) => `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
const delta = (id, text) => [id, "delta", { text }];
const done = (id) => [id, "state", { status: "idle" }];

async function withServer(handler, fn) {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const call = { method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : undefined };
    requests.push(call);
    handler(call, res, requests);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, requests); }
  finally { server.closeAllConnections(); server.close(); }
}
const stream = (res, events, { drop = false } = {}) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  if (drop) res.write(sse(events), () => res.destroy()); else res.end(sse(events));
};
const json = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

async function cli(argv, url, env = { HATCH_API_KEY: "k" }) {
  const { ctx, home } = await makeContext({ env: { HATCH_API_URL: url, ...env }, fetch: globalThis.fetch });
  const deps = { env: ctx.env, fetch: globalThis.fetch, home, cwd: home, store: ctx.store, browser: { open() {} }, stdin: new PassThrough(), stdout: sink(), stderr: sink(), sleep: async () => {} };
  const code = await main(argv, deps);
  return { code, out: deps.stdout.text(), err: deps.stderr.text(), store: ctx.store };
}

test("parseSse reads ids, events and JSON data across chunk boundaries", async () => {
  const text = sse([delta("1", "he"), delta("2", "llo")]);
  const events = [];
  for await (const e of parseSse([text.slice(0, 17), text.slice(17)])) events.push(e);
  assert.deepEqual(events.map((e) => [e.id, e.event, e.data.text]), [["1", "delta", "he"], ["2", "delta", "llo"]]);
});

test("resumable reconnects after the last cursor and never repeats an event", async () => {
  const opened = [];
  const open = (after) => {
    opened.push(after);
    return (async function* () {
      if (after === undefined) { yield { id: "1", event: "delta", data: { text: "a" } }; yield { id: "2", event: "delta", data: { text: "b" } }; throw new Error("reset"); }
      yield { id: "2", event: "delta", data: { text: "b" } }; // replayed overlap
      yield { id: "3", event: "delta", data: { text: "c" } };
      yield { id: "4", event: "state", data: { status: "idle" } };
    })();
  };
  const observer = new RunObserver();
  let printed = "";
  for await (const e of resumable(open, { sleep: async () => {} })()) printed += observer.apply(e);
  assert.deepEqual(opened, [undefined, "2"]);
  assert.equal(printed, "abc");
  assert.equal(observer.status, "idle");
  assert.equal(observer.cursor, "4");
});

test("resumable does not retry an HTTP error", async () => {
  const { HatchError } = await import("../src/errors.js");
  let opens = 0;
  const open = () => { opens++; return (async function* () { throw new HatchError("nope", { code: "forbidden", status: 403 }); })(); };
  await assert.rejects(async () => { for await (const _ of resumable(open, { sleep: async () => {} })()); }, /nope/);
  assert.equal(opens, 1);
});

test("ask starts a conversation with a product, streams the reply, and resumes by cursor after a drop", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations") return json(res, { conversation_id: "c1" }, 201);
    if (call.method === "POST" && call.url === "/v1/conversations/c1/messages") return stream(res, [delta("1", "Hel")], { drop: true });
    if (call.url === "/v1/conversations/c1/events?after=1") return stream(res, [delta("1", "Hel"), delta("2", "lo"), done("3")]);
    json(res, {}, 404);
  }, async (url, requests) => {
    const r = await cli(["ask", "hello", "--product", "p1", "--stream"], url);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Hello\n");
    const send = requests.find((c) => c.method === "POST" && c.url.endsWith("/messages"));
    assert.equal(send.headers.accept, "text/event-stream");
    assert.match(send.body.client_message_id, /^[0-9a-f-]{36}$/);
    assert.equal(send.headers["idempotency-key"], send.body.client_message_id);
    assert.deepEqual(requests.find((c) => c.url === "/v1/conversations").body, { product_id: "p1" });
    assert.ok(!requests.some((c) => c.url.includes("cancel")), "dropping a connection never cancels the Run");
  });
});

test("a send dropped before any event is retried with the same client_message_id", async () => {
  await withServer((call, res, requests) => {
    if (call.method !== "POST") return json(res, {}, 404);
    const attempts = requests.filter((c) => c.method === "POST").length;
    if (attempts === 1) return res.destroy();
    stream(res, [delta("1", "ok"), done("2")]);
  }, async (url, requests) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--stream", "--key", "k-1"], url);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "ok\n");
    assert.deepEqual(requests.map((c) => c.body?.client_message_id), ["k-1", "k-1"]);
  });
});

test("giving up on a stream says how to resume and does not cancel", async () => {
  await withServer((call, res) => stream(res, [delta("7", "x")], { drop: true }), async (url, requests) => {
    const r = await cli(["conversation", "watch", "c1", "--after", "6"], url);
    assert.equal(r.code, 1);
    assert.match(r.err, /--after 7/);
    assert.ok(!requests.some((c) => c.method === "POST"));
  });
});

test("ask --wait returns the reply, or the run id when it is still running", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations/c1/messages?wait=30") return json(res, { status: "running", run_id: "r9" }, 202);
    json(res, {}, 404);
  }, async (url) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--wait=30", "--json"], url);
    const out = JSON.parse(r.out);
    assert.equal(out.run_id, "r9");
    assert.equal(out.conversation_id, "c1");
    assert.ok(out.client_message_id);
    assert.match(r.err, /conversation show c1/);
  });
});

test("conversations, show and stop use the Chat API routes", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations") return json(res, { conversations: [{ id: "c1", product_id: "p1", updated_at: "t" }] });
    if (call.url === "/v1/conversations/c1/snapshot") return json(res, { status: "running", cursor: "5", run_id: "r1", messages: [{ id: "m1", role: "user", text: "hi", created_at: "t" }] });
    if (call.url === "/v1/conversations/c1/runs/r1/cancel") return json(res, { requested: true }, 202);
    json(res, {}, 404);
  }, async (url) => {
    assert.match((await cli(["conversations"], url)).out, /c1 .*p1/);
    const shown = await cli(["conversation", "show", "c1", "--json"], url);
    assert.equal(JSON.parse(shown.out).cursor, "5");
    assert.match((await cli(["conversation", "stop", "c1", "r1"], url)).out, /Stop requested/);
  });
});

test("browser sessions and API keys both authenticate Chat calls", async () => {
  await withServer((call, res) => json(res, { conversations: [], got: call.headers.authorization }), async (url, requests) => {
    await cli(["conversations"], url, { HATCH_API_KEY: "key-1" });
    const { ctx } = await makeContext({ env: { HATCH_API_URL: url } });
    await ctx.store.put("default", { api_url: url, token: "session-1", kind: "session" });
    const deps = { env: { HATCH_API_URL: url }, fetch: globalThis.fetch, home: ctx.home, cwd: ctx.cwd, store: ctx.store, browser: { open() {} }, stdin: new PassThrough(), stdout: sink(), stderr: sink() };
    assert.equal(await main(["conversations"], deps), 0);
    assert.deepEqual(requests.map((c) => c.headers.authorization), ["Bearer key-1", "Bearer session-1"]);
  });
});

test("Studio worker chat sends a client_message_id and streams; assistant does too", async () => {
  await withServer((call, res) => {
    if (call.method === "POST") return stream(res, [delta("1", "done"), done("2")]);
    json(res, {}, 404);
  }, async (url, requests) => {
    const w = await cli(["chat", "p1", "research", "go", "--stream", "--key", "w-1"], url);
    assert.equal(w.out, "done\n");
    const a = await cli(["assistant", "go", "--stream", "--key", "a-1"], url);
    assert.equal(a.out, "done\n");
    assert.deepEqual(requests.map((c) => [c.url, c.body.client_message_id]), [
      ["/v1/creator/products/p1/workers/research/messages", "w-1"],
      ["/v1/creator/assistant/conversation/messages", "a-1"]
    ]);
  });
});

test("MCP exposes the Chat tools and chat_send reports the key it used", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations/c1/messages?wait=20") return json(res, { status: "idle", reply: { text: "Hi." } });
    json(res, {}, 404);
  }, async (url) => {
    const { ctx } = await makeContext({ env: { HATCH_API_URL: url, HATCH_API_KEY: "k" }, fetch: globalThis.fetch });
    const server = new McpServer(ctx, new CommandRegistry(COMMANDS));
    const names = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools.map((t) => t.name);
    for (const n of ["conversations_list", "chat_send", "conversation_show", "chat_stop"]) assert.ok(names.includes(n), n);
    const call = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat_send", arguments: { conversation_id: "c1", content: "hi", wait: 20, client_message_id: "m-1" } } });
    assert.equal(JSON.parse(call.result.content[0].text).client_message_id, "m-1");
  });
});
