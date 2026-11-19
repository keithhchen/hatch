import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { restartRetryKey } from "../chat/restartRetry.js";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { SwitchedEngine } from "../chat/runEngine.js";
import { RunHandoff } from "../chat/runSupervisor.js";
import { HttpKimiHostedApi, kimiHostedConfigFromEnvironment, type KimiHostedApi } from "./api.js";
import { KimiHostedEngine, type ReportPublisher } from "./engine.js";
import { MemoryKimiSessions } from "./sessions.js";

type Scripted = { type: string; data?: unknown };
const status = (value: string, stop?: string): Scripted => ({ type: "session.status", data: { status: value, ...stop ? { stop_reason: { type: stop } } : {} } });
const HAPPY: Scripted[] = [
  status("running"),
  { type: "agent.message", data: { content: [{ type: "text", text: "先看首页。" }] } },
  { type: "agent.tool_use", data: { tool_use: { id: "shell:1", name: "shell", input: { command: "curl x", description: "抓取首页" } } } },
  { type: "agent.tool_result", data: { tool_result: { tool_use_id: "shell:1", structured_content: [{ type: "text", text: "200 OK" }] } } },
  { type: "agent.message", data: { content: [{ type: "text", text: "报告已交付。" }] } },
  status("idle", "end_turn")
];
const REPORT = Buffer.from("<html><head><title>官网诊断</title></head><body>ok</body></html>");

/** The Kimi platform, as far as the engine touches it. Only in tests. */
class FakeKimi {
  script: Scripted[] = HAPPY;
  artifacts: Array<{ id: string; name: string; created_at: string }> = [{ id: "art_1", name: "report.html", created_at: "2026-11-19T10:00:00Z" }, { id: "art_2", name: "report.pdf", created_at: "2026-11-19T10:01:00Z" }];
  /** The stream stays open after this many events until `release()`. */
  holdAfter: number | undefined;
  duplicate = false;
  /** The whole script was sent: the session's own state says it ended. */
  private delivered = false;
  created = 0;
  messages: unknown[] = [];
  interrupts = 0;
  archived = 0;
  cursors: Array<string | null> = [];
  private released: (() => void) | undefined;
  private gate = new Promise<void>(resolve => { this.released = resolve; });
  release() { this.released?.(); }
  readonly server = http.createServer((request, response) => void this.handle(request, response));
  async listen(): Promise<string> { await new Promise<void>(resolve => this.server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`; }
  close() { this.server.closeAllConnections(); this.server.close(); }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse) {
    const url = new URL(request.url!, "http://x");
    const path = url.pathname.replace(/^\/v1/, "");
    const body = await new Promise<string>(resolve => { let text = ""; request.on("data", chunk => text += chunk); request.on("end", () => resolve(text)); });
    const json = (value: unknown, code = 200) => { response.writeHead(code, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (request.headers.authorization !== "Bearer test-key") return json({ error: "unauthorized" }, 401);
    if (request.method === "POST" && path === "/sessions") { this.created++; return json({ id: `sess_${this.created}` }); }
    if (request.method === "POST" && /\/events$/.test(path)) {
      const { events } = JSON.parse(body) as { events: Array<{ type: string }> };
      for (const event of events) { if (event.type === "user.interrupt") this.interrupts++; else this.messages.push(event); }
      return json({});
    }
    if (request.method === "POST" && /\/archive$/.test(path)) { this.archived++; return json({}); }
    if (request.method === "GET" && /^\/sessions\/[^/]+$/.test(path)) {
      const end = this.script.at(-1)!;
      const ended = this.delivered && end.type === "session.status";
      return json({ status: ended ? (end.data as { status: string }).status : "running", ...ended && (end.data as any).stop_reason ? { stop_reason: (end.data as any).stop_reason } : {} });
    }
    if (request.method === "GET" && path.endsWith("/events/stream")) {
      this.cursors.push(url.searchParams.get("cursor"));
      const after = Number(url.searchParams.get("cursor")?.slice(1) ?? 0);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: control\ndata: {\"type\":\"hello\"}\n\n");
      for (let index = after; index < this.script.length; index++) {
        if (this.holdAfter !== undefined && index >= this.holdAfter) { await this.gate; if (response.destroyed) return; }
        const frame = `id: e${index + 1}\ndata: ${JSON.stringify({ id: `evt_${index + 1}`, ...this.script[index] })}\n\n`;
        response.write(frame);
        if (this.duplicate) response.write(frame);
      }
      this.delivered = true;
      return response.end();
    }
    if (request.method === "GET" && path === "/artifacts") return json({ items: this.artifacts });
    if (request.method === "GET" && /^\/artifacts\/[^/]+\/content$/.test(path)) { response.writeHead(200); return response.end(REPORT); }
    json({ error: "not found" }, 404);
  }
}

type Fake = ReturnType<typeof fakeTurn>;
function fakeTurn(runId: string, clientMessageId: string, signal: AbortSignal = new AbortController().signal) {
  const published: Array<Record<string, any>> = [];
  const result: { completed?: any; failed?: any } = {};
  const state = { status: "queued", start: async () => { state.status = "running"; }, keepsReplyFrom: () => undefined, complete: async (reply: unknown) => { result.completed = reply; state.status = "completed"; return true; }, fail: async (failure: unknown) => { result.failed = failure; state.status = "failed"; } };
  const turn = {
    run: { id: runId, clientMessageId, conversationId: "c1" }, conversation: { id: "c1", publicId: "p1", briefSnapshot: undefined },
    scope: { productId: "prod", userId: "user" }, input: { task_start: true }, persistedUser: { content: "" },
    state, publish: (message: Record<string, any>) => { published.push(message); }, signal,
    claimSteered: async () => [], onSteer: () => () => undefined
  };
  return { turn: turn as any, published, result };
}

async function harness(options: { script?: Scripted[]; withPublisher?: boolean } = {}) {
  const kimi = new FakeKimi();
  if (options.script) kimi.script = options.script;
  const baseUrl = await kimi.listen();
  const api = new HttpKimiHostedApi({ apiKey: "test-key", baseUrl, agentId: "agent", environmentId: "env" });
  const sessions = new MemoryKimiSessions();
  const stored: Array<Record<string, any>> = [];
  const published: Array<{ owner: unknown; name: string; title: string; bytes: number }> = [];
  const publisher: ReportPublisher = { publish: async (owner, name, html, title) => { published.push({ owner, name, title, bytes: html.length }); return `https://hatch.test/html/page-${published.length}?t=sig`; } };
  const engine = new KimiHostedEngine<{ productId: string; userId: string }>({ api, sessions, store: { append: async (event: any) => { stored.push(event); } } as any, publisher: options.withPublisher === false ? undefined : publisher, reconnectMs: 10 });
  return { kimi, api, sessions, stored, published, engine, done: () => kimi.close() };
}

test("a Run is one session: the Brief message, mirrored events, the HTML report published once, the link as the final reply", async () => {
  const h = await harness();
  try {
    const { turn, published, result } = fakeTurn("run1", "m1");
    await h.engine.run(turn);
    assert.equal(h.kimi.created, 1);
    assert.equal(h.kimi.messages.length, 1);
    assert.equal(result.failed, undefined);
    const kinds = published.map(message => `${message.type}${message.status ? `:${message.status}` : ""}`);
    assert.deepEqual(kinds.filter(kind => kind !== "assistant.delta"), ["tool_call.delta:requested", "tool_call.delta:completed", "turn.completed"]);
    assert.equal(published.filter(message => message.type === "assistant.delta").length, 3);
    assert.deepEqual(h.stored.map(event => [event.type, event.status, event.name]), [["tool.call", "requested", "shell"], ["tool.call", "completed", "shell"]]);
    assert.equal(h.stored[0]!.activity_message, "抓取首页");
    assert.equal(h.published.length, 1);
    assert.equal(h.published[0]!.name, "report.html");
    assert.equal(h.published[0]!.title, "官网诊断");
    assert.match(result.completed.message.content, /先看首页。\n\n报告已交付。\n\n报告链接：https:\/\/hatch\.test\/html\/page-1\?t=sig$/);
    assert.deepEqual(result.completed.visibleParts.map((part: any) => part.type), ["text", "tool_call", "text", "text"]);
    assert.equal(h.sessions.rows[0]!.finished, true);
    assert.equal(h.kimi.archived, 1);
  } finally { h.done(); }
});

test("the first message is the Brief block and then the task start, as the pi path builds its context", async () => {
  const h = await harness();
  try {
    const { turn } = fakeTurn("run1", "m1");
    turn.conversation.briefSnapshot = { id: "brief_1", spec_digest: `sha256:${"a".repeat(64)}`, submitted_at: "2026-11-19T10:00:00Z", fields: [{ id: "url", label: "网址", required: true, value: "https://www.aoneng.com" }] };
    await h.engine.run(turn);
    const text = (h.kimi.messages[0] as any).data.content[0].text as string;
    assert.match(text, /^# Task Brief\n/);
    assert.match(text, /https:\/\/www\.aoneng\.com/);
    assert.match(text, /Start the task described in the Brief\.\n<\/system-reminder>$/);
  } finally { h.done(); }
});

test("events replayed by the stream publish the report once; a replayed Run finds the recorded page", async () => {
  const h = await harness();
  try {
    h.kimi.duplicate = true;
    await h.engine.run(fakeTurn("run1", "m1").turn);
    assert.equal(h.published.length, 1);
    // The Run completed but its session was never finished (a crash between): the restart retry finds the recorded page, not a second one.
    h.sessions.rows[0]!.finished = false;
    const retry = fakeTurn("run2", restartRetryKey("run1"));
    await h.engine.run(retry.turn);
    assert.equal(h.published.length, 1);
    assert.equal(h.kimi.created, 1);
    assert.equal(h.kimi.messages.length, 1);
    assert.match(retry.result.completed.message.content, /page-1\?t=sig$/);
  } finally { h.done(); }
});

test("a restart hands the session to the retry Run, which reattaches from the cursor: no second session, no second message", async () => {
  const h = await harness();
  try {
    h.kimi.holdAfter = 3;
    const abort = new AbortController();
    const first = fakeTurn("run1", "m1", abort.signal);
    const running = h.engine.run(first.turn);
    for (let waited = 0; waited < 200 && h.sessions.rows[0]?.cursor !== "e3"; waited++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(h.sessions.rows[0]!.cursor, "e3");
    abort.abort(new RunHandoff("Runtime shutting down"));
    await running;
    assert.equal(first.result.failed, undefined);
    assert.equal(first.result.completed, undefined);
    assert.equal(h.kimi.interrupts, 0, "a restart does not interrupt the session");
    h.kimi.holdAfter = undefined;
    const second = fakeTurn("run2", restartRetryKey("run1"));
    await h.engine.run(second.turn);
    assert.equal(h.kimi.created, 1);
    assert.equal(h.kimi.messages.length, 1);
    assert.equal(h.kimi.cursors.at(-1), "e3");
    assert.equal(second.result.failed, undefined);
    assert.equal(h.published.length, 1);
    assert.equal(h.sessions.rows[0]!.runId, "run2");
  } finally { h.done(); }
});

test("a message that is not the restart retry starts its own session", async () => {
  const h = await harness();
  try {
    await h.sessions.create({ sessionId: "old", conversationId: "c1", runId: "run0" });
    await h.engine.run(fakeTurn("run1", "m1").turn);
    assert.equal(h.kimi.created, 1);
  } finally { h.done(); }
});

test("a stop interrupts the session", async () => {
  const h = await harness();
  try {
    h.kimi.holdAfter = 2;
    const abort = new AbortController();
    const running = h.engine.run(fakeTurn("run1", "m1", abort.signal).turn);
    for (let waited = 0; waited < 200 && !h.sessions.rows[0]?.cursor; waited++) await new Promise(resolve => setTimeout(resolve, 10));
    abort.abort(new Error("The Run stopped"));
    await running;
    assert.equal(h.kimi.interrupts, 1);
    assert.equal(h.sessions.rows[0]!.finished, true);
  } finally { h.done(); }
});

test("failures end the Run failed, never completed: terminated session, no report, wrong stop, unreachable platform, missing setup", async () => {
  const cases: Array<[string, Scripted[], RegExp]> = [
    ["terminated", [status("running"), status("terminated")], /terminated/],
    ["no report", [status("running"), status("idle", "end_turn")], /without saving an HTML report/],
    ["wrong stop", [status("running"), status("idle", "max_tokens")], /max_tokens/],
    ["custom tool asked", [status("running"), status("idle", "requires_action")], /custom tool/]
  ];
  for (const [name, script, pattern] of cases) {
    const h = await harness({ script });
    try {
      if (name === "no report") h.kimi.artifacts = [{ id: "art_2", name: "report.pdf", created_at: "2026-11-19T10:01:00Z" }];
      const { turn, result } = fakeTurn("run1", "m1");
      await h.engine.run(turn);
      assert.equal(result.completed, undefined, name);
      assert.match(result.failed.message, pattern, name);
      assert.equal(h.published.length, 0, name);
      assert.equal(h.sessions.rows[0]!.finished, true, name);
    } finally { h.done(); }
  }
  const h = await harness();
  try {
    h.kimi.close();
    const down = fakeTurn("run1", "m1");
    await new KimiHostedEngine({ api: h.api as KimiHostedApi, sessions: h.sessions, store: { append: async () => undefined } as any, publisher: undefined }).run(down.turn);
    assert.match(down.result.failed.message, /cannot publish HTML pages/);
    const bare = fakeTurn("run2", "m2");
    await new KimiHostedEngine({ api: undefined, sessions: h.sessions, store: { append: async () => undefined } as any, publisher: undefined }).run(bare.turn);
    assert.match(bare.result.failed.message, /KIMI_HOSTED_AGENT_ID/);
  } finally { h.done(); }
});

test("the platform refusing the key fails the Run with its own message", async () => {
  const h = await harness();
  try {
    const bad = new KimiHostedEngine({ api: new HttpKimiHostedApi({ apiKey: "wrong", baseUrl: `http://127.0.0.1:${(h.kimi.server.address() as AddressInfo).port}/v1`, agentId: "a", environmentId: "e" }), sessions: h.sessions, store: { append: async () => undefined } as any, publisher: { publish: async () => "x" } });
    const { turn, result } = fakeTurn("run1", "m1");
    await bad.run(turn);
    assert.match(result.failed.message, /401/);
    assert.equal(result.completed, undefined);
  } finally { h.done(); }
});

test("the switch: only a Product with the engine_kimi_hosted row runs on Kimi; the row is read on every Run", async () => {
  const calls: string[] = [];
  const engine = (name: string) => ({ run: async () => { calls.push(name); } });
  const rows: Array<[string, string]> = [];
  const capabilities = new InMemoryProductCapabilities(rows);
  const switched = new SwitchedEngine<{ productId: string }>({ capabilities, capability: "engine_kimi_hosted", standard: engine("pi"), alternative: engine("kimi") });
  const turn = (productId: string) => ({ scope: { productId } }) as any;
  await switched.run(turn("p1"));
  rows.push(["p1", "engine_kimi_hosted"]);
  await switched.run(turn("p1"));
  await switched.run(turn("p2"));
  rows.pop();
  await switched.run(turn("p1"));
  assert.deepEqual(calls, ["pi", "kimi", "pi", "pi"]);
  const bare = new SwitchedEngine<{ productId: string }>({ capabilities: undefined, capability: "engine_kimi_hosted", standard: engine("pi"), alternative: engine("kimi") });
  await bare.run(turn("p1"));
  assert.equal(calls.at(-1), "pi");
});

test("config comes from the environment, and is absent when the ids are not set", () => {
  assert.equal(kimiHostedConfigFromEnvironment({ KIMI_HOSTED_API_KEY: "k" }), undefined);
  assert.deepEqual(kimiHostedConfigFromEnvironment({ LLM_API_KEY: "k", KIMI_HOSTED_AGENT_ID: "a", KIMI_HOSTED_ENVIRONMENT_ID: "e", KIMI_HOSTED_VAULT_ID: "v" }), { apiKey: "k", agentId: "a", environmentId: "e", vaultId: "v", baseUrl: "https://api.moonshot.cn/v1" });
});
