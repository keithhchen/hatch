// Test fixtures only: the small recording below is never read by product code.
import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage, Context, Message } from "@earendil-works/pi-ai";
import type { RunContext } from "../agentRuntime.js";
import { InMemoryProductCapabilities } from "../agentBox/capabilities.js";
import { AgentBoxes } from "../agentBox/boxes.js";
import { BuyerFiles, FileLinks } from "../agentBox/files.js";
import { HtmlLinks, HtmlPages, MemoryHtmlPageRepository } from "../agentBox/htmlPages.js";
import { AgentBoxMode } from "../agentBox/tools.js";
import { harness } from "../assets/kit.test.js";
import { ModelProfileError } from "../errors/modelProfile.js";
import { llmProfile } from "../llmProfiles.js";
import { InMemoryModelRoleResolver, profileForRole } from "../modelRoles.js";
import { ReplayAdapter } from "../modelAdapters/index.js";
import { PiAgentRuntime } from "../piAgentRuntime.js";
import type { OutboundMessage, RunStart } from "../protocol.js";
import { ServerToolExecutor } from "../serverTools.js";
import { renderSkillsSection } from "../skills.js";
import { toolRegistry } from "../tools.js";
import { ToolBridge } from "../toolBridge.js";
import { LoadTestReplay } from "./mode.js";
import { parseReplayScript, type ReplayScript } from "./script.js";
import { replayStreamFn } from "./stream.js";
import type { ReplayTiming } from "./timing.js";
import { ReplayToolRunner } from "./tools.js";

const REAL_PRODUCT = "159c0f12-6e23-4512-af7b-928833d199d7";
const LOAD_PRODUCT = "11111111-2222-4333-8444-555555555555";
const REPORT = "<!doctype html><html><body><h1>Recorded report</h1></body></html>";
const FINAL = "报告已生成。";

const act = (message: string) => ({ activity_message: message });
const SCRIPT: ReplayScript = parseReplayScript({
  version: 1,
  turns: [
    { duration_ms: 4000, thinking: "Plan the audit first, then measure.", tool_calls: [
      { name: "box.bash", arguments: { command: "curl -I https://example.com", ...act("检查 HTTPS") } },
      { name: "site.ip_info", arguments: { target: "example.com", ...act("查询服务器位置") } }] },
    { duration_ms: 3000, tool_calls: [{ name: "box.write", arguments: { path: "r/report.html", content: REPORT, ...act("撰写报告") } }] },
    { duration_ms: 2000, tool_calls: [{ name: "box.save_file", arguments: { path: "r/report.html", ...act("保存") } }] },
    { duration_ms: 1000, tool_calls: [{ name: "box.publish_html", arguments: { file_id: "recorded-file", title: "Recorded title", ...act("发布") } }] },
    { duration_ms: 500, text: FINAL, tool_calls: [] }
  ],
  tool_calls: [
    { name: "box.bash", duration_ms: 2000, result: { output: "exit code: 0\nstdout:\nHTTP/2 200" } },
    { name: "site.ip_info", duration_ms: 1000, result: { target: "example.com", ips: [{ ip: "203.0.113.7", country: "United States" }] } },
    { name: "box.write", duration_ms: 100, result: { output: "Wrote r/report.html" } },
    { name: "box.save_file", duration_ms: 300, result: { file_id: "recorded-file", url: "https://recorded.invalid" } },
    { name: "box.publish_html", duration_ms: 87, result: { page_id: "recorded", url: "https://recorded.invalid" } }
  ],
  publish: { title: "Recorded title", html: REPORT }
});

/** Time that never passes: every wait is noted and returns at once. */
const instantTiming = (speed = 1) => { const waits: number[] = []; const timing: ReplayTiming = { speed, sleep: async (ms) => { waits.push(ms); } }; return { waits, timing }; };

const assistant = (turn: number): Message[] => Array.from({ length: turn }, (_, i) => ({ role: "assistant", content: [], api: "openai-completions", provider: "load_test_replay", model: "m", stopReason: "stop", timestamp: i, usage: {} } as unknown as AssistantMessage));
const contextAt = (turn: number, tools = true): Context => ({ messages: [{ role: "user", content: "go", timestamp: 0 }, ...assistant(turn)], ...tools ? { tools: [{ name: "bash", description: "", parameters: {} as never }] } : {} });
const model = { id: "load_test_replay", api: "openai-completions", provider: "load_test_replay" } as never;

async function play(stream: ReturnType<typeof replayStreamFn>, context: Context, signal?: AbortSignal) {
  const events = [];
  for await (const event of await stream(model, context, signal ? { signal } : undefined)) events.push(event);
  const done = events.at(-1)!;
  return { events, message: done.type === "done" ? done.message : done.type === "error" ? done.error : undefined };
}

test("turn N of the conversation is recorded turn N, and the recording's tool calls carry their place in it", async () => {
  const stream = replayStreamFn(SCRIPT, { timing: instantTiming().timing, modelToolName: (name) => name.split(".")[1]! });
  const first = await play(stream, contextAt(0));
  assert.equal(first.message!.stopReason, "toolUse");
  assert.deepEqual(first.message!.content.map((block) => block.type), ["thinking", "toolCall", "toolCall"]);
  const calls = first.message!.content.filter((block) => block.type === "toolCall");
  assert.deepEqual(calls.map((call) => [call.id, call.name]), [["replay-0", "bash"], ["replay-1", "ip_info"]]);
  // The same position answers the same way, however often and wherever it is asked.
  assert.deepEqual((await play(stream, contextAt(0))).message!.content, first.message!.content);
  const third = await play(stream, contextAt(2));
  assert.deepEqual(third.message!.content.map((block) => block.type === "toolCall" ? block.id : block.type), ["replay-3"]);
});

test("a conversation that diverges continues with the remaining turns and ends with the final text when they run out", async () => {
  const stream = replayStreamFn(SCRIPT, { timing: instantTiming().timing });
  // A follow-up Run after turn 3 (an extra user message adds no assistant message): the next recorded turn is the fourth.
  const resumed = await play(stream, { ...contextAt(3), messages: [...contextAt(3).messages, { role: "user", content: "also publish", timestamp: 9 }] });
  assert.equal(resumed.message!.content.find((block) => block.type === "toolCall" && block.name !== undefined && block.id === "replay-4") !== undefined, true);
  for (const past of [contextAt(4), contextAt(9)]) {
    const closing = await play(stream, past);
    assert.equal(closing.message!.stopReason, "stop");
    assert.deepEqual(closing.message!.content, [{ type: "text", text: FINAL }]);
  }
  // A call that offers no tools (the tool budget is spent) can only answer.
  assert.deepEqual((await play(stream, contextAt(1, false))).message!.content, [{ type: "text", text: FINAL }]);
});

test("a call streams: start at once, thinking and arguments in deltas, and the recorded duration is spent across them", async () => {
  const { waits, timing } = instantTiming();
  const { events } = await play(replayStreamFn(SCRIPT, { timing, chunkChars: 8 }), contextAt(0));
  assert.equal(events[0]!.type, "start");
  assert.ok(events.filter((event) => event.type === "thinking_delta").length > 1);
  assert.ok(events.some((event) => event.type === "toolcall_delta"));
  assert.equal(events.at(-1)!.type, "done");
  assert.equal(Math.round(waits.reduce((sum, ms) => sum + ms, 0)), 4000);
});

test("timing is honoured with an injectable speed factor", async () => {
  for (const speed of [1, 4, 50]) {
    const { waits, timing } = instantTiming(speed);
    await play(replayStreamFn(SCRIPT, { timing }), contextAt(0));
    assert.equal(Math.round(waits.reduce((sum, ms) => sum + ms, 0)), 4000 / speed);
    const tools = new ReplayToolRunner(SCRIPT, timing, async () => ({ page_id: "p", url: "u" }));
    waits.length = 0;
    await tools.run("box.bash", {}, undefined, "replay-0");
    assert.deepEqual(waits, [2000 / speed]);
  }
  assert.match((await play(replayStreamFn(SCRIPT, { timing: { speed: 0, sleep: async () => {} } }), contextAt(0))).message!.errorMessage ?? "", /speed/);
});

test("an aborted call ends as aborted instead of playing on", async () => {
  const controller = new AbortController();
  const timing: ReplayTiming = { speed: 1, sleep: async (_ms, signal) => { controller.abort(); signal?.throwIfAborted(); } };
  const { message } = await play(replayStreamFn(SCRIPT, { timing }), contextAt(0), controller.signal);
  assert.equal(message!.stopReason, "aborted");
});

test("tools answer with the recorded result of the same call, falling back to the tool name; publish_html publishes for real", async () => {
  const { timing, waits } = instantTiming();
  const published: Array<{ bytes: string; title: string }> = [];
  const tools = new ReplayToolRunner(SCRIPT, timing, async (html, title) => { published.push({ bytes: html.toString("utf8"), title }); return { page_id: "real-page", url: "https://real.test/html/real-page" }; });
  assert.ok(tools.handles("box.bash") && tools.handles("site.page_speed") && tools.handles("attachments.read") && tools.handles("hatch.web_search"));
  assert.equal(tools.handles("studio.anything"), false);
  // By the call's own place in the recording.
  assert.deepEqual(await tools.run("site.ip_info", {}, undefined, "replay-1"), SCRIPT.tool_calls[1]!.result);
  // By name when the id does not name a call of that tool.
  assert.deepEqual(await tools.run("box.bash", {}, undefined, "call_other"), SCRIPT.tool_calls[0]!.result);
  // Every recorded call of a name is used once; then there is nothing to answer with, said honestly.
  const none = await tools.run("box.bash", {});
  assert.equal((none as { status: string }).status, "error");
  assert.deepEqual(waits, [1000, 2000]);
  const page = await tools.run("box.publish_html", { file_id: "whatever", title: "Model title" });
  assert.deepEqual(page, { page_id: "real-page", url: "https://real.test/html/real-page" });
  assert.deepEqual(published, [{ bytes: REPORT, title: "Model title" }]);
});

/** The Runtime pieces a real turn of the load-test Product has, with in-memory storage. */
async function setup() {
  const { repository, blobs } = await harness();
  const files = new BuyerFiles(repository, blobs, new FileLinks("secret", "https://example.test"));
  const pages = new HtmlPages(new MemoryHtmlPageRepository(), files, new HtmlLinks("secret", "https://example.test"));
  const capabilities = new InMemoryProductCapabilities([[LOAD_PRODUCT, "load_test_replay"], [LOAD_PRODUCT, "access_code"], [REAL_PRODUCT, "access_code"], [REAL_PRODUCT, "deliverable_html"], [REAL_PRODUCT, "agent_box"]]);
  const mode = new AgentBoxMode({ capabilities, boxes: new AgentBoxes({ find: async () => { throw new Error("a replay never opens a box"); }, create: async () => { throw new Error("a replay never opens a box"); } }), workDir: "/home/agent/work", pdf: {} as never, files, pages });
  const { waits, timing } = instantTiming(10);
  const reads: Array<string | undefined> = [];
  const replay = new LoadTestReplay({ capabilities, boxDefinitions: mode.definitions(), publish: (owner, email, name, html, title) => mode.publishBytes(owner, email, name, html, title), timing, readScript: async (root) => { reads.push(root); return SCRIPT; } });
  return { pages, replay, waits, reads };
}

test("replaying the recording through the real Runtime gives the recorded event sequence and a really published page", async (t) => {
  const { pages, replay, waits } = await setup();
  const added = replay.definitions().filter((definition) => !toolRegistry.has(definition.name));
  for (const definition of added) toolRegistry.set(definition.name, definition);
  t.after(() => { for (const definition of added) toolRegistry.delete(definition.name); });

  const turn = (await replay.turnFor({ productId: LOAD_PRODUCT, userId: "code:MSC1", corpusRoot: "/corpus" }))!;
  assert.deepEqual(turn.extraTools.sort(), ["box.bash", "box.publish_html", "box.save_file", "box.write", "site.ip_info"]);
  const serverTools = new ServerToolExecutor();
  serverTools.setReplay(turn.tools);
  const input = { type: "client.message", run_id: "run_replay", conversation_id: "conversation_replay", message: { role: "user", content: "audit example.com" } } as RunStart;
  const ctx = {
    productId: LOAD_PRODUCT, state: { status: "running" }, messages: [{ role: "user", content: "audit example.com" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    serverTools, toolBridge: new ToolBridge({} as never, serverTools), allowedExternalTools: turn.extraTools, replay: turn.stream,
    toolCallLimit: { max: 100, uncounted: [] }
  } as unknown as RunContext;
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver({ products: { [LOAD_PRODUCT]: "replay" } }) });
  const events: OutboundMessage[] = [];
  for await (const event of runtime.run(input, ctx)) events.push(event);

  // Every recorded call ran, in order, and completed with its recorded result (the publish with the real page).
  const completed = events.flatMap((event) => event.type === "tool_call.delta" && event.status === "completed" ? [event] : []);
  assert.deepEqual(completed.map((event) => event.name), ["box.bash", "site.ip_info", "box.write", "box.save_file", "box.publish_html"]);
  assert.deepEqual(completed[1]!.result, SCRIPT.tool_calls[1]!.result);
  assert.match(String(completed[4]!.result?.url), /^https:\/\/example\.test\/html\//);
  const text = events.flatMap((event) => event.type === "assistant.delta" && event.delta.kind === "text" ? [event.delta.content] : []).join("");
  assert.equal(text, FINAL);
  assert.equal(events.at(-1)!.type, "turn.completed");
  // The page is real: a row and a signed link, built from the recorded bytes.
  const url = await pages.latestUrlSince(LOAD_PRODUCT, "code:MSC1", new Date(0));
  assert.match(url ?? "", /^https:\/\/example\.test\/html\/[0-9a-f-]{36}\?t=/);
  const [, id, token] = /\/html\/([^?]+)\?t=(.+)$/.exec(url!)!;
  assert.equal((await pages.open(id!, token!))?.toString("utf8"), REPORT);
  // Time was spent as recorded, at the injected speed: 10.5 s of turns and 3.4 s of tools, a tenth of it.
  const total = waits.reduce((sum, ms) => sum + ms, 0);
  assert.ok(Math.abs(total - (10_500 + 3_387) / 10) < 5, String(total));
});

test("the real Product cannot replay, however it is set up", async () => {
  const { replay, reads } = await setup();
  // It has every capability a real audit Product has, and no load_test_replay row.
  assert.equal(await replay.turnFor({ productId: REAL_PRODUCT, userId: "code:REAL", corpusRoot: "/corpus" }), undefined);
  assert.deepEqual(reads, [], "its Corpus is never even read for a recording");
  // Even with its model setting pointed at the replay profile, nothing is answered from a recording.
  const serverTools = new ServerToolExecutor();
  const input = { type: "client.message", run_id: "run_real", conversation_id: "conversation_real", message: { role: "user", content: "go" } } as RunStart;
  const ctx = { productId: REAL_PRODUCT, state: { status: "running" }, messages: [{ role: "user", content: "go" }], clientTools: [], sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) }, serverTools } as unknown as RunContext;
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver({ products: { [REAL_PRODUCT]: "replay" } }) });
  await assert.rejects(async () => { for await (const _ of runtime.run(input, ctx)) { /* nothing */ } }, ModelProfileError);
  // The profile itself refuses without a recording, and is no model for any other role.
  assert.throws(() => new ReplayAdapter().streamFn(llmProfile("replay"), { apiKey: "x", baseUrl: "", provider: "", thinkingLevel: "low" }), ModelProfileError);
  for (const role of ["assistant", "factory", "ingest", "inspiration", "content", "title"] as const) assert.throws(() => profileForRole(role, "replay", "test"), ModelProfileError);
  assert.equal(profileForRole("chat", "replay", "test").family, "replay");
});

test("a Product with the capability must run on the replay profile, never a real model beside recorded tools", async () => {
  const { replay } = await setup();
  const turn = (await replay.turnFor({ productId: LOAD_PRODUCT, userId: "u", corpusRoot: "/c" }))!;
  const input = { type: "client.message", run_id: "run_mixed", conversation_id: "conversation_mixed", message: { role: "user", content: "go" } } as RunStart;
  const ctx = { productId: LOAD_PRODUCT, state: { status: "running" }, messages: [{ role: "user", content: "go" }], clientTools: [], sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) }, serverTools: new ServerToolExecutor(), replay: turn.stream } as unknown as RunContext;
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver({ products: { [LOAD_PRODUCT]: "kimi-k3.1-pro" } }) });
  await assert.rejects(async () => { for await (const _ of runtime.run(input, ctx)) { /* nothing */ } }, ModelProfileError);
});

test("every replayed call logs load_test_replay", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  t.mock.method(console, "warn", (line: string) => { lines.push(line); });
  const { timing } = instantTiming();
  await play(replayStreamFn(SCRIPT, { timing }), contextAt(0));
  await new ReplayToolRunner(SCRIPT, timing, async () => ({ page_id: "p", url: "u" })).run("box.bash", {}, undefined, "replay-0");
  const entries = lines.map((line) => JSON.parse(line) as { event: string; kind: string });
  assert.deepEqual(entries.map((entry) => [entry.event, entry.kind]), [["load_test_replay", "model_turn"], ["load_test_replay", "tool"]]);
});

test("a recording whose turns and results disagree is refused", () => {
  assert.throws(() => parseReplayScript({ ...SCRIPT, tool_calls: SCRIPT.tool_calls.slice(1) }), /requested tool calls/);
  assert.throws(() => parseReplayScript({ version: 1, turns: [], tool_calls: [], publish: { title: "t", html: "x" } }));
});
