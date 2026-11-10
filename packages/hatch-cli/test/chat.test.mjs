import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";
import test from "node:test";
import { main } from "../src/cli.js";
import { COMMANDS } from "../src/commands.js";
import { McpServer } from "../src/mcp.js";
import { CommandRegistry } from "../src/registry.js";
import { RunObserver, isTerminal, parseSse, resumable } from "../src/run.js";
import { makeContext, sink } from "./helpers.mjs";

// These tests prove the client's behaviour against a local HTTP server. They are not end-to-end product evidence.
// The Chat shapes mirror runtime-server: index.ts handleConversationHttpRequest, chat/sinks.ts, chat/conversationFeed.ts.
const sse = (events) => events.map(([id, event, data]) => `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
// Live events (deltas, turn.state, message.accepted) carry no id; durable journal events carry the cursor as id.
const delta = (text) => [undefined, "assistant.delta", { type: "assistant.delta", run_id: "r1", delta: { kind: "text", content: text } }];
const journal = (cursor, journalType, payload) => [cursor, "journal.event", { type: "journal.event", cursor, journal_type: journalType, run_id: "r1", payload, created_at: "t" }];
const runState = (cursor, status) => journal(cursor, "run.state", { id: "r1", status });
const done = (cursor) => runState(cursor, "completed");
// Studio workers still speak their own wire (id per event, `delta`/`state`); only Chat changed.
const workerDelta = (id, text) => [id, "delta", { text }];
const workerDone = (id) => [id, "state", { status: "idle" }];

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
  const text = sse([journal("1", "message.created", { role: "user" }), delta("hello")]);
  const events = [];
  for await (const e of parseSse([text.slice(0, 17), text.slice(17)])) events.push(e);
  assert.deepEqual(events.map((e) => [e.id, e.event]), [["1", "journal.event"], [undefined, "assistant.delta"]]);
  assert.equal(events[1].data.delta.content, "hello");
});

test("RunObserver folds the real Chat events: message.accepted, turn.state, deltas, journal run.state", () => {
  const observer = new RunObserver();
  const apply = (e) => observer.apply({ id: e[0], event: e[1], data: e[2] });
  assert.equal(apply([undefined, "message.accepted", { type: "message.accepted", conversation_id: "c1", run_id: "r1", client_message_id: "k", outcome: "started" }]), "");
  assert.equal(observer.runId, "r1");
  apply([undefined, "turn.state", { type: "turn.state", run_id: "r1", status: "running" }]);
  assert.equal(observer.status, "running");
  assert.equal(apply(delta("Hel")), "Hel");
  assert.equal(apply([undefined, "assistant.delta", { type: "assistant.delta", run_id: "r1", delta: { kind: "status", content: "thinking" } }]), "", "only text deltas are reply text");
  assert.equal(apply(delta("lo")), "lo");
  apply(journal("7", "message.created", { role: "assistant" }));
  assert.equal(observer.cursor, "7", "the cursor is the journal event id");
  apply(runState("8", "completed"));
  assert.deepEqual([observer.text, observer.status, observer.cursor], ["Hello", "completed", "8"]);
  apply([undefined, "turn.failed", { type: "turn.failed", run_id: "r1", error: { code: "run_cancelled", message: "Run cancelled" } }]);
  assert.deepEqual([observer.status, observer.error.code], ["failed", "run_cancelled"]);
});

test("a Chat Run ends at a terminal journal run.state, not at a live turn.state", () => {
  const ev = (e) => ({ id: e[0], event: e[1], data: e[2] });
  assert.equal(isTerminal(ev([undefined, "turn.state", { type: "turn.state", run_id: "r1", status: "completed" }])), false);
  assert.equal(isTerminal(ev(runState("3", "running"))), false);
  assert.equal(isTerminal(ev(runState("3", "waiting_for_tool"))), false);
  for (const status of ["completed", "failed", "cancelled", "interrupted"]) assert.equal(isTerminal(ev(runState("3", status))), true, status);
});

test("resumable reconnects after the last cursor and never repeats an event", async () => {
  const opened = [];
  const state = (status) => ({ id: "4", event: "journal.event", data: { journal_type: "run.state", run_id: "r1", payload: { status } } });
  const open = (after) => {
    opened.push(after);
    return (async function* () {
      if (after === undefined) { yield { id: "1", event: "journal.event", data: { journal_type: "message.created", payload: {} } }; yield { id: "2", event: "journal.event", data: { journal_type: "run.created", payload: {} } }; throw new Error("reset"); }
      yield { id: "2", event: "journal.event", data: { journal_type: "run.created", payload: {} } }; // replayed overlap
      yield { event: "assistant.delta", data: { delta: { kind: "text", content: "c" } } };
      yield state("completed");
    })();
  };
  const observer = new RunObserver();
  let printed = "";
  for await (const e of resumable(open, { sleep: async () => {} })()) printed += observer.apply(e);
  assert.deepEqual(opened, [undefined, "2"]);
  assert.equal(printed, "c");
  assert.equal(observer.status, "completed");
  assert.equal(observer.cursor, "4");
});

test("resumable does not retry an HTTP error", async () => {
  const { HatchError } = await import("../src/errors.js");
  let opens = 0;
  const open = () => { opens++; return (async function* () { throw new HatchError("nope", { code: "forbidden", status: 403 }); })(); };
  await assert.rejects(async () => { for await (const _ of resumable(open, { sleep: async () => {} })()); }, /nope/);
  assert.equal(opens, 1);
});

test("ask starts a conversation in the product, streams the reply, and resumes with after_cursor after a drop", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations?product_id=p1") return json(res, { conversation: { id: "c1" }, created: true }, 201);
    if (call.method === "POST" && call.url === "/v1/conversations/c1/messages?product_id=p1") {
      return stream(res, [[undefined, "message.accepted", { type: "message.accepted", run_id: "r1" }], delta("Hel"), journal("5", "run.created", { id: "r1" })], { drop: true });
    }
    if (call.url === "/v1/conversations/c1/events?product_id=p1&after_cursor=5") return stream(res, [delta("lo"), done("6")]);
    json(res, { error: { code: "not_found", message: call.url } }, 404);
  }, async (url, requests) => {
    const r = await cli(["ask", "hello", "--product", "p1", "--stream", "--json"], url);
    assert.equal(r.code, 0, r.err);
    const out = JSON.parse(r.out);
    assert.deepEqual([out.conversation_id, out.run_id, out.status, out.cursor, out.reply.text], ["c1", "r1", "completed", "6", "Hello"]);
    const send = requests.find((c) => c.method === "POST" && c.url.includes("/messages"));
    assert.equal(send.headers.accept, "text/event-stream");
    assert.match(send.body.client_message_id, /^[0-9a-f-]{36}$/);
    const create = requests.find((c) => c.url === "/v1/conversations?product_id=p1");
    assert.deepEqual(create.body, { client_request_id: `${send.body.client_message_id}:conversation` }, "product_id is a query parameter; the body rejects unknown fields");
    assert.ok(!requests.some((c) => c.url.includes("cancel")), "dropping a connection never cancels the Run");
  });
});

test("the plain-text stream prints only new reply text and a failed Run exits 1", async () => {
  await withServer((call, res) => {
    if (call.method === "POST") return stream(res, [delta("par"), runState("2", "failed")]);
    json(res, {}, 404);
  }, async (url) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--stream"], url);
    assert.equal(r.out, "par\n");
    assert.equal(r.code, 1);
  });
});

test("a send dropped before any event is retried with the same client_message_id", async () => {
  await withServer((call, res, requests) => {
    if (call.method !== "POST") return json(res, {}, 404);
    const attempts = requests.filter((c) => c.method === "POST").length;
    if (attempts === 1) return res.destroy();
    stream(res, [delta("ok"), done("2")]);
  }, async (url, requests) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--stream", "--key", "k-1"], url);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "ok\n");
    assert.deepEqual(requests.map((c) => c.body?.client_message_id), ["k-1", "k-1"]);
  });
});

test("a replayed send of a finished Run returns its result from one request, however the stream ends", async () => {
  await withServer((call, res) => {
    if (call.method !== "POST") return json(res, {}, 404);
    // What the Runtime answers a replay after the Run ended: the accept, the reply, the end, then the stream closes.
    stream(res, [[undefined, "message.accepted", { type: "message.accepted", run_id: "r1", outcome: "replayed" }], delta("the answer"), done("9")]);
  }, async (url, requests) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--stream", "--key", "k-9", "--json"], url);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([JSON.parse(r.out).reply.text, JSON.parse(r.out).status, JSON.parse(r.out).cursor], ["the answer", "completed", "9"]);
    assert.equal(requests.length, 1, "nothing is opened to wait for an end that already happened");
  });
});

test("watch resumes from --after with after_cursor and stops at a terminal run.state", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations/c1/events?product_id=p1&after_cursor=6") return stream(res, [delta("x"), runState("7", "running"), runState("8", "cancelled")]);
    json(res, {}, 404);
  }, async (url) => {
    const r = await cli(["conversation", "watch", "c1", "--product", "p1", "--after", "6", "--json"], url);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual([JSON.parse(r.out).status, JSON.parse(r.out).cursor], ["cancelled", "8"]);
  });
});

test("watch started mid-Run prints the answer so far from the snapshot, then only what follows its cursor", async () => {
  const offsetDelta = (text, offset) => [undefined, "assistant.delta", { type: "assistant.delta", run_id: "r1", delta: { kind: "text", content: text, offset } }];
  await withServer((call, res) => {
    if (call.url === "/v1/conversations/c1/snapshot?product_id=p1") return json(res, { cursor: 6, runs: [{ id: "r1", status: "running", partial_output: "Hello " }] });
    // The Runtime catches the reader up with the whole text so far: what the reader holds is skipped by offset.
    if (call.url === "/v1/conversations/c1/events?product_id=p1&after_cursor=6") return stream(res, [offsetDelta("Hello wor", 0), offsetDelta("ld", 9), done("7")]);
    json(res, {}, 404);
  }, async (url) => {
    const r = await cli(["conversation", "watch", "c1", "--product", "p1"], url);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "Hello world\n");
  });
});

test("giving up on a stream says how to resume and does not cancel", async () => {
  await withServer((call, res) => stream(res, [journal("7", "run.created", { id: "r1" })], { drop: true }), async (url, requests) => {
    const r = await cli(["conversation", "watch", "c1", "--product", "p1", "--after", "6"], url);
    assert.equal(r.code, 1);
    assert.match(r.err, /--after 7/);
    assert.ok(!requests.some((c) => c.method === "POST"));
  });
});

test("ask --wait flattens {run, outcome, reply}, or returns the run id from the 202", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations/c1/messages?product_id=p1&wait=30") return json(res, { run_id: "r9", outcome: "started", status: "running" }, 202);
    if (call.url === "/v1/conversations/c1/messages?product_id=p1&wait=60") return json(res, { run: { id: "r2", status: "completed" }, outcome: "started", reply: "Hi there." });
    if (call.url === "/v1/conversations/c1/messages?product_id=p1&wait=5") return json(res, { run: { id: "r3", status: "failed" }, outcome: "started", reply: "" });
    json(res, {}, 404);
  }, async (url) => {
    const pending = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--wait=30", "--json"], url);
    const out = JSON.parse(pending.out);
    assert.deepEqual([out.run_id, out.status, out.conversation_id], ["r9", "running", "c1"]);
    assert.ok(out.client_message_id);
    assert.match(pending.err, /conversation show c1 --product p1/);
    const answered = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--wait"], url);
    assert.equal(answered.out, "Hi there.\n");
    const failed = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--wait=5"], url);
    assert.equal(failed.code, 1);
  });
});

test("ask without --product is a usage error: every Chat call is scoped by product_id", async () => {
  await withServer((call, res) => json(res, {}, 500), async (url, requests) => {
    const r = await cli(["ask", "hi", "--conversation", "c1"], url);
    assert.equal(r.code, 2);
    assert.equal(requests.length, 0);
  });
});

test("conversations lists with next_cursor; show derives status from runs; stop cancels the run", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations?product_id=p1") return json(res, { conversations: [{ id: "c1", title: "T", updated_at: "t" }], next_cursor: "n1", sent_message_count: 1 });
    if (call.url === "/v1/conversations?product_id=p1&cursor=n1") return json(res, { conversations: [], sent_message_count: 1 });
    if (call.url === "/v1/conversations/c1/snapshot?product_id=p1") {
      return json(res, { conversation: { id: "c1" }, runs: [{ id: "r0", status: "completed" }, { id: "r1", status: "running" }], messages: [{ run_id: "r0", role: "user", content: "hi", timestamp: "t" }], events: [], cursor: 5, pending_tool_calls: [] });
    }
    if (call.method === "POST" && call.url === "/v1/conversations/c1/runs/r1/cancel?product_id=p1") return json(res, { run: { id: "r1", status: "cancelled" }, submission: null });
    json(res, { error: { code: "not_found", message: call.url } }, 404);
  }, async (url, requests) => {
    const listed = await cli(["conversations", "--product", "p1", "--json"], url);
    assert.equal(JSON.parse(listed.out).next_cursor, "n1");
    assert.match((await cli(["conversations", "--product", "p1"], url)).out, /c1 .*T/);
    assert.equal((await cli(["conversations", "--product", "p1", "--cursor", "n1"], url)).code, 0);
    const shown = await cli(["conversation", "show", "c1", "--product", "p1", "--json"], url);
    const snap = JSON.parse(shown.out);
    assert.deepEqual([snap.cursor, snap.run_id, snap.status], [5, "r1", "running"]);
    assert.match((await cli(["conversation", "show", "c1", "--product", "p1"], url)).out, /running {2}run r1 {2}cursor 5\n\[r0\] you .*\nhi/);
    const stopped = await cli(["conversation", "stop", "c1", "r1", "--product", "p1"], url);
    assert.match(stopped.out, /r1 cancelled/);
    assert.deepEqual(requests.at(-1).body, {});
  });
});

test("an API error body {error:{code,message}} is reported", async () => {
  await withServer((call, res) => json(res, { error: { code: "conversation_not_found", message: "Conversation c9 was not found." } }, 404), async (url) => {
    const r = await cli(["conversation", "show", "c9", "--product", "p1"], url);
    assert.equal(r.code, 1);
    assert.match(r.err, /Conversation c9 was not found/);
  });
});

test("browser sessions and API keys both authenticate Chat calls", async () => {
  await withServer((call, res) => json(res, { conversations: [] }), async (url, requests) => {
    await cli(["conversations", "--product", "p1"], url, { HATCH_API_KEY: "key-1" });
    const { ctx } = await makeContext({ env: { HATCH_API_URL: url } });
    await ctx.store.put("default", { api_url: url, token: "session-1", kind: "session" });
    const deps = { env: { HATCH_API_URL: url }, fetch: globalThis.fetch, home: ctx.home, cwd: ctx.cwd, store: ctx.store, browser: { open() {} }, stdin: new PassThrough(), stdout: sink(), stderr: sink() };
    assert.equal(await main(["conversations", "--product", "p1"], deps), 0);
    assert.deepEqual(requests.map((c) => c.headers.authorization), ["Bearer key-1", "Bearer session-1"]);
  });
});

test("Studio worker chat sends a client_message_id and streams; assistant does too", async () => {
  await withServer((call, res) => {
    if (call.method === "POST") return stream(res, [workerDelta("1", "done"), workerDone("2")]);
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
    if (call.url === "/v1/conversations/c1/messages?product_id=p1&wait=20") return json(res, { run: { id: "r1", status: "completed" }, outcome: "started", reply: "Hi." });
    json(res, {}, 404);
  }, async (url) => {
    const { ctx } = await makeContext({ env: { HATCH_API_URL: url, HATCH_API_KEY: "k" }, fetch: globalThis.fetch });
    const server = new McpServer(ctx, new CommandRegistry(COMMANDS));
    const tools = (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })).result.tools;
    for (const n of ["conversations_list", "chat_send", "conversation_show", "chat_stop"]) assert.ok(tools.some((t) => t.name === n), n);
    assert.ok(tools.find((t) => t.name === "chat_send").inputSchema.required.includes("product_id"));
    const call = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chat_send", arguments: { product_id: "p1", conversation_id: "c1", content: "hi", wait: 20, client_message_id: "m-1" } } });
    const out = JSON.parse(call.result.content[0].text);
    assert.deepEqual([out.client_message_id, out.reply.text, out.status], ["m-1", "Hi.", "completed"]);
  });
});

test("a Studio stream, whose frames have no event name, prints the reply and ends at run_end", async () => {
  const frame = (id, data) => `id: ${id}\ndata: ${JSON.stringify(data)}\n\n`;
  await withServer((call, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(`event: accepted\ndata: {"message":{"id":"m1"}}\n\n${frame("1", { type: "state" })}${frame("2", { type: "message" })}${frame("3", { type: "delta", text: "hi" })}${frame("4", { type: "run_end", status: "completed" })}`);
  }, async (url) => {
    const r = await cli(["ask", "hi", "--conversation", "c1", "--product", "p1", "--stream"], url);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "hi\n");
  });
});

const QUOTA = { code: "provider_quota", message: "The model provider has no quota or balance left." };

test("a Studio Run that fails prints its error and exits 1, streamed or waited", async () => {
  await withServer((call, res) => {
    if (call.method === "POST" && call.url.endsWith("?wait=5")) return json(res, { status: "failed", error: QUOTA, message: { id: "m1" } });
    if (call.method === "POST") return stream(res, [["1", "run_end", { type: "run_end", status: "failed", error: QUOTA }], [undefined, "done", { status: "failed", error: QUOTA }]]);
    json(res, {}, 404);
  }, async (url) => {
    const streamed = await cli(["assistant", "hi", "--stream"], url);
    assert.equal(streamed.code, 1);
    assert.match(streamed.err, /provider_quota.*no quota or balance/);
    const waited = await cli(["chat", "p1", "research", "hi", "--wait=5"], url);
    assert.equal(waited.code, 1);
    assert.match(waited.err, /provider_quota.*no quota or balance/);
  });
});

test("ask sends --brief answers when it starts a conversation, and MCP sends brief_answers", async () => {
  await withServer((call, res) => {
    if (call.url === "/v1/conversations?product_id=p1") return json(res, { conversation: { id: "c1" }, created: true }, 201);
    json(res, { message: { id: "m1" }, run_id: "r1", status: "running" }, 202);
  }, async (url, requests) => {
    await cli(["ask", "hi", "--product", "p1", "--brief", "goal=ship", "--brief", "context=a=b"], url);
    assert.deepEqual(requests[0].body.brief_answers, [{ field_id: "goal", value: "ship" }, { field_id: "context", value: "a=b" }]);
    const chatSend = COMMANDS.find((c) => c.mcp?.name === "chat_send");
    assert.deepEqual(chatSend.mcp.toArgs({ content: "hi", product_id: "p1", brief_answers: { goal: "ship" } }).flags.brief, ["goal=ship"]);
  });
});
