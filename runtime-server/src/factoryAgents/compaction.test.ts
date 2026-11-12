import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { CompactionPolicy, SummarizeInput } from "../compactionStrategy.js";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { userMessage } from "./imageRefs.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";
import { WorkbenchRuntime } from "./runtime.js";
import { WorkbenchStore } from "./store.js";

const policy: Partial<CompactionPolicy> = { trigger: 1500, prune: 600, tail: 150, cacheTtlMs: 60_000, minPruneTokens: 50, timeoutMs: 2_000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 }) as AgentMessage;
const reply = (text: string) => ({ role: "assistant", content: [{ type: "text", text }], api: "openai-completions", provider: "p", model: "m", usage, stopReason: "stop", timestamp: 1 }) as AgentMessage;
const call = (id: string, name: string, args: Record<string, unknown>) => ({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], api: "openai-completions", provider: "p", model: "m", usage, stopReason: "toolUse", timestamp: 1 }) as AgentMessage;
const result = (id: string, name: string, chars: number) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: "r".repeat(chars) }], isError: false, timestamp: 1 }) as AgentMessage;
const text = (messages: AgentMessage[]) => JSON.stringify(messages);

async function harness(options: { summarize?: (input: SummarizeInput<AgentMessage>) => Promise<string>; seed?: AgentMessage[]; fail?: (call: number) => string | undefined; delayMs?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-compaction-"));
  const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const clock = { now: 1_000_000 };
  const log: string[] = [];
  const modelCalls: AgentMessage[][] = [];
  const runtime = new WorkbenchRuntime(store, {
    env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash" },
    compaction: { contextWindow: 4_096, policy, now: () => clock.now, summarize: options.summarize ?? (async () => "## Goal\nsummary") },
    agentFactory: factory => new Agent({ ...factory.agentOptions, initialState: { ...factory.initialState, model: createFactoryLlmModel({ env: factory.env }) }, streamFn: (_model, context) => {
      const n = modelCalls.push(context.messages as AgentMessage[]);
      log.push("model call");
      const error = options.fail?.(n);
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(), content: error ? [] : [{ type: "text", text: `Reply ${n}` }], stopReason: error ? "error" : "stop", ...(error ? { errorMessage: error } : {}), usage };
      const stream = createAssistantMessageEventStream();
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: "stop", message }); stream.end(message); }, options.delayMs ?? 20);
      return stream;
    } }),
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  runtime.events.on("event", event => events.push(event));
  const session = await store.create("research");
  if (options.seed) await store.update(session.id, state => { state.context = options.seed!; });
  const say = (value: string) => userMessage(value, [], { kind: "expert", itemId: value, text: value });
  const idle = async () => { for (let i = 0; i < 400; i++) { if (!runtime.isRunning(session.id)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("run did not end"); };
  const internals = runtime as unknown as { compactNow(id: string, messages: AgentMessage[], signal: AbortSignal, extra?: object): Promise<{ kind: string; messages: AgentMessage[]; dropped?: number }>; touched: Map<string, number> };
  return { runtime, store, session, clock, log, modelCalls, events, say, idle, internals, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

/** Plain conversation over the summary trigger, with no tool results for pruning to take. */
const talk = (count = 30): AgentMessage[] => Array.from({ length: count }, (_, index) => index % 2 ? reply(`answer ${index} ${"w".repeat(400)}`) : user(`question ${index} ${"w".repeat(400)}`));
const bigHistory = (): AgentMessage[] => [
  user("start the work"), call("a", "read", { path: "input/manual/brief.md" }), result("a", "read", 1_200), call("b", "list", { directory: "input" }), result("b", "list", 1_200),
  reply("noted"), user("second"), reply("ok"), user("third"), reply("fine"), user("latest"), reply("done")
];

test("old tool results are pruned only after the provider cache expired; while it is alive the context is untouched", async () => {
  const h = await harness();
  try {
    const history = bigHistory();
    const signal = new AbortController().signal;
    h.internals.touched.set(h.session.id, h.clock.now);
    h.clock.now += 1_000;
    assert.equal((await h.internals.compactNow(h.session.id, history, signal)).kind, "none");
    h.clock.now += 120_000;
    const outcome = await h.internals.compactNow(h.session.id, history, signal);
    assert.equal(outcome.kind, "pruned");
    assert.match(text(outcome.messages), /Tool result pruned: read/);
    assert.deepEqual(outcome.messages.slice(-4), history.slice(-4), "the recent tail is verbatim");
    assert.equal((outcome.messages[1] as { content: unknown }), (history[1] as { content: unknown }), "calls are kept");
  } finally { await h.close(); }
});

test("a summary keeps the unfinished request, paths read and written and identifiers; one retry restores omissions; no reminder reaches the summarizer", async () => {
  const asked: SummarizeInput<AgentMessage>[] = [];
  const answers = ["## Goal\nvague", "## Goal\nbrief.md out/report.md ticket ABC-42 order 7788123 reconcile ABC-42 and 7788123 before friday please"];
  const h = await harness({ summarize: async input => { asked.push(input); return answers.shift()!; } });
  try {
    const history = [
      user("reconcile ABC-42 and 7788123 before friday please"), call("a", "read", { path: "input/manual/brief.md" }), result("a", "read", 1_200),
      call("w", "write", { path: "out/report.md", content: "x" }), result("w", "write", 1_200), reply("partial"), user("filler"), reply("filler"), user("latest"), reply("done")
    ];
    h.clock.now += 1_000_000;
    const outcome = await h.internals.compactNow(h.session.id, history, new AbortController().signal, { force: true });
    assert.equal(outcome.kind, "summarized");
    assert.equal(asked.length, 2, "one retry");
    const summary = text(outcome.messages.slice(0, 1));
    for (const item of ["input/manual/brief.md", "out/report.md", "ABC-42", "7788123"]) assert.ok(summary.includes(item) || asked[1]!.instructions.includes(item), item);
    assert.ok(!text(asked.flatMap(input => input.messages)).includes("system-reminder"));
    assert.ok(!text(outcome.messages).includes("system-reminder"));
  } finally { await h.close(); }
});

test("a failed summary degrades with a visible notice; the chat history is untouched", async () => {
  const h = await harness({ summarize: async () => { throw new Error("model down"); } });
  try {
    h.clock.now += 1_000_000;
    const outcome = await h.internals.compactNow(h.session.id, bigHistory(), new AbortController().signal, { force: true });
    assert.equal(outcome.kind, "degraded");
    const degraded = h.events.find(event => event.type === "compaction_degraded")!;
    assert.ok((degraded.dropped as number) > 0);
    assert.match(String(degraded.note), /dropped/);
    assert.equal(h.events.find(event => event.type === "compacted")!.degraded, true);
    assert.equal(h.events.find(event => event.type === "compacting")!.compactionId, degraded.compactionId);
    assert.equal((await h.store.get(h.session.id)).messages.length, 0);
  } finally { await h.close(); }
});

test("background compaction after the reply is preempted by a new message, which waits for it to end", async () => {
  let first = true;
  const h = await harness({ summarize: async input => {
    if (!first) return "## Goal\nsummary";
    first = false;
    await new Promise<void>(resolve => input.signal.addEventListener("abort", () => resolve()));
    await new Promise(resolve => setTimeout(resolve, 40));
    h.log.push("background ended");
    return "unused";
  } });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await h.idle();
    await h.store.update(h.session.id, state => { state.context = [...talk(), ...state.context]; });
    h.log.length = 0;
    (h.runtime as unknown as { scheduleBackground(id: string): void }).scheduleBackground(h.session.id);
    for (let i = 0; i < 100 && !(h.runtime as unknown as { background: { has(id: string): boolean } }).background.has(h.session.id); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 50));
    await h.runtime.send(h.session.id, h.say("two"));
    await h.idle();
    assert.equal(h.log[0], "background ended", "the new message waited for the background job to end");
    assert.ok(h.log.includes("model call"));
  } finally { await h.close(); }
});

test("a message sent while the conversation compacts waits and joins afterwards", async () => {
  const h = await harness({ seed: talk(), summarize: async () => { await new Promise(resolve => setTimeout(resolve, 120)); return "## Goal\nsummary"; } });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal((await h.runtime.send(h.session.id, h.say("during"))).queued, true);
    assert.ok((await h.store.get(h.session.id)).queue?.some(message => (message as { origin?: { text?: string } }).origin?.text === "during"), "on the session while compacting");
    await h.idle();
    const texts = (await h.store.get(h.session.id)).messages.filter(message => message.role === "user").map(message => (message as { origin?: { text?: string } }).origin?.text);
    assert.deepEqual(texts, ["one", "during"]);
    assert.ok(h.events.some(event => event.type === "compacted"));
  } finally { await h.close(); }
});

test("a provider overflow is recovered by compacting and continuing, at most twice", async () => {
  const overflow = "prompt is too long: 213462 tokens > 200000 maximum";
  const seed = talk(12);
  const recovered = await harness({ seed, fail: n => n <= 2 ? overflow : undefined });
  try {
    await recovered.runtime.send(recovered.session.id, recovered.say(`go ${"w".repeat(400)}`));
    await recovered.idle();
    assert.equal((await recovered.store.get(recovered.session.id)).error, undefined);
    assert.equal(recovered.modelCalls.length, 3);
    assert.equal((await recovered.store.get(recovered.session.id)).status, "completed");
  } finally { await recovered.close(); }
  const stuck = await harness({ seed, fail: () => overflow });
  try {
    await stuck.runtime.send(stuck.session.id, stuck.say(`go ${"w".repeat(400)}`));
    await stuck.idle();
    assert.equal(stuck.modelCalls.length, 3, "bounded: the first call plus two recoveries");
    assert.equal((await stuck.store.get(stuck.session.id)).status, "failed");
  } finally { await stuck.close(); }
});

test("no hard-coded token threshold or last-N rule remains", async () => {
  const source = await readFile(new URL("../../src/factoryAgents/runtime.ts", import.meta.url), "utf8");
  assert.ok(!source.includes("165000") && !source.includes("length - 12"));
});
