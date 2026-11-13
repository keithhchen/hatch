import assert from "node:assert/strict";
import { InMemoryModelRoleResolver } from "../modelRoles.js";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { userMessage } from "./imageRefs.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";
import { MessageAlreadyAccepted, WorkbenchRuntime } from "./runtime.js";
import { WorkerConversation } from "../conversations/workerConversation.js";
import { WORKERS } from "../conversations/workers.js";
import { WorkbenchStore } from "./store.js";
import { emptySurfaces } from "../usage/usage.js";
import { UsageCap, UsageCapExceeded } from "../usage/usageCap.js";

type Call = { tools: Array<{ name: string; description: string }>; last: string };

/** Real store and runtime; only the model is scripted. `plan(call)` is the tool the model calls, if any. */
async function harness(options: { plan?: (call: number) => string | undefined; toolSupport?: (name: string) => readonly ("web" | "cli")[] | "*"; delayMs?: number; heartbeatMs?: number; staleMs?: number; fail?: (call: number) => boolean; cap?: UsageCap } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-send-"));
  const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const calls: Call[] = [];
  const build = () => new WorkbenchRuntime(store, {
    models: new InMemoryModelRoleResolver({ roles: { factory: "deepseek-v4-flash" } }), role: "factory",
    ...(options.cap ? { usage: { recorder: { record: async () => undefined }, accountId: "c1", cap: options.cap } } : {}),
    toolSupport: options.toolSupport as never, heartbeatMs: options.heartbeatMs, staleMs: options.staleMs,
    agentFactory: factory => new Agent({ ...factory.agentOptions, initialState: { ...factory.initialState, model: createFactoryLlmModel({ profile: factory.profile, env: factory.env }) }, streamFn: (_model, context, streamOptions) => {
      const call = calls.length + 1;
      const final = context.messages.at(-1);
      calls.push({ tools: (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description })), last: JSON.stringify(final?.content) });
      const tool = options.plan?.(call);
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k3.1-pro", timestamp: Date.now(),
        content: tool ? [{ type: "toolCall", id: `call-${call}`, name: tool, arguments: { directory: "input" } }] : [{ type: "text", text: `Reply ${call}` }],
        stopReason: options.fail?.(call) ? "error" : tool ? "toolUse" : "stop", ...(options.fail?.(call) ? { errorMessage: "model down" } : {}), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      const timer = setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(message); }, options.delayMs ?? 30);
      // A provider call that honors the stop: it ends as aborted, and the loop ends without reading its steering queue.
      streamOptions?.signal?.addEventListener("abort", () => { clearTimeout(timer); const aborted = { ...message, content: [], stopReason: "aborted" as const }; stream.push({ type: "error", reason: "aborted", error: aborted }); stream.end(aborted); }, { once: true });
      return stream;
    } }),
  });
  const runtime = build();
  const events: Array<{ type: string; sessionId?: string }> = [];
  runtime.events.on("event", event => events.push(event));
  const session = await store.create("research");
  const say = (text: string) => userMessage(text, [], { kind: "expert", itemId: text, text });
  const idle = async () => { for (let i = 0; i < 400; i++) { if (!runtime.isRunning(session.id)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("run did not end"); };
  return { runtime, build, store, session, calls, events, say, idle, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
}

const userTexts = (messages: AgentMessage[]) => messages.filter(message => message.role === "user").map(message => (message as { origin?: { text?: string } }).origin?.text);

test("send: simultaneous messages make one run; the other steers it and nothing is lost", async () => {
  const h = await harness({ plan: call => call === 1 ? "list" : undefined });
  try {
    const [first, second, third] = await Promise.all([h.runtime.send(h.session.id, h.say("one")), h.runtime.send(h.session.id, h.say("two")), h.runtime.send(h.session.id, h.say("three"))]);
    assert.deepEqual([first.queued, second.queued, third.queued], [false, true, true]);
    await h.idle();
    assert.equal(h.events.filter(event => event.type === "run_end").length, 1, "one Run");
    assert.deepEqual(userTexts((await h.store.get(h.session.id)).messages), ["one", "two", "three"], "every message is in history, in order");
    assert.equal((await h.store.get(h.session.id)).status, "completed");
  } finally { await h.close(); }
});

test("send: a message that lands as the run is ending still gets answered", async () => {
  const h = await harness({ delayMs: 20 });
  try {
    await h.runtime.send(h.session.id, h.say("first"));
    // Keep sending while the run winds down: every message must end up in history and answered.
    for (let i = 0; i < 12; i++) { await new Promise(resolve => setTimeout(resolve, 8)); await h.runtime.send(h.session.id, h.say(`late ${i}`)); }
    await h.idle();
    const texts = userTexts((await h.store.get(h.session.id)).messages);
    assert.equal(texts.length, 13);
    const history = (await h.store.get(h.session.id)).messages;
    assert.equal(history.at(-1)?.role, "assistant", "the last message was answered");
  } finally { await h.close(); }
});

test("send: while compacting, a message waits and joins afterwards", async () => {
  const h = await harness({ plan: call => call === 1 ? "list" : undefined, delayMs: 60 });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await new Promise(resolve => setTimeout(resolve, 20));
    const internals = h.runtime as unknown as { compacting: Set<string>; release(id: string): void };
    internals.compacting.add(h.session.id);
    assert.equal((await h.runtime.send(h.session.id, h.say("during"))).queued, true);
    assert.equal((await h.store.get(h.session.id)).queue?.length, 1, "queued on the session, not injected");
    internals.compacting.delete(h.session.id); internals.release(h.session.id);
    await h.idle();
    assert.deepEqual(userTexts((await h.store.get(h.session.id)).messages), ["one", "during"]);
  } finally { await h.close(); }
});

test("system reminder: after all history at every model call, from the latest message's client, never stored", async () => {
  const h = await harness({ plan: call => call === 1 ? "list" : undefined, delayMs: 50 });
  try {
    await h.runtime.send(h.session.id, h.say("one"), { client: "cli", language: "en" });
    await new Promise(resolve => setTimeout(resolve, 10));
    await h.runtime.send(h.session.id, h.say("two"), { client: "mcp", device: "macos" });
    await h.idle();
    assert.ok(h.calls.length >= 2);
    for (const call of h.calls) assert.match(call.last, /<system-reminder>/);
    assert.match(h.calls[0]!.last, /client: cli/);
    assert.match(h.calls.at(-1)!.last, /client: mcp/);
    assert.ok(!JSON.stringify((await h.store.get(h.session.id)).messages).includes("system-reminder"), "not in history");
    assert.ok(!JSON.stringify((await h.store.get(h.session.id)).context).includes("system-reminder"), "not in the context compaction reads");
  } finally { await h.close(); }
});

test("tools: declared once in a fixed order, described where available, authorized against the latest client", async () => {
  const h = await harness({ plan: call => call === 1 ? "list" : undefined, toolSupport: name => name === "list" ? ["web"] : "*" });
  try {
    await h.runtime.send(h.session.id, h.say("look"), { client: "cli" });
    await h.idle();
    const names = h.calls[0]!.tools.map(tool => tool.name);
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes("grep") && names.includes("list") && names.includes("read"));
    assert.deepEqual(h.calls.at(-1)!.tools, h.calls[0]!.tools, "the list does not change within a conversation");
    assert.match(h.calls[0]!.tools.find(tool => tool.name === "list")!.description, /Available on: web$/);
    assert.ok(!h.calls[0]!.tools.find(tool => tool.name === "read")!.description.includes("Available on"));
    const result = (await h.store.get(h.session.id)).messages.find(message => message.role === "toolResult");
    assert.equal((result as { isError?: boolean }).isError, true);
    assert.match(JSON.stringify(result), /list is not available on cli\. Available on: web/);
  } finally { await h.close(); }
});

test("closing every client does not stop a run: only an explicit stop does", async () => {
  const h = await harness({ delayMs: 80 });
  try {
    await h.runtime.send(h.session.id, h.say("go"));
    // No subscriber exists at all; the run goes on and finishes.
    await h.idle();
    assert.equal((await h.store.get(h.session.id)).status, "completed");
    await h.runtime.send(h.session.id, h.say("again"));
    h.runtime.stop(h.session.id);
    await h.idle();
    assert.equal((await h.store.get(h.session.id)).status, "interrupted");
  } finally { await h.close(); }
});

test("send: every Run has its own id, shared by the messages that steer it", async () => {
  const h = await harness({ plan: call => call === 1 ? "list" : undefined });
  try {
    const first = await h.runtime.send(h.session.id, h.say("one"));
    const steered = await h.runtime.send(h.session.id, h.say("two"));
    assert.match(first.runId, /^run_/);
    assert.notEqual(first.runId, h.session.id, "a Run is not the conversation");
    assert.equal(steered.runId, first.runId, "a steering message joins the running Run");
    assert.equal(h.runtime.runId(h.session.id), first.runId);
    await h.idle();
    assert.equal(h.runtime.runId(h.session.id), undefined);
    assert.notEqual((await h.runtime.send(h.session.id, h.say("three"))).runId, first.runId, "the next Run is a new one");
    await h.idle();
  } finally { await h.close(); }
});

test("send: a message steered into a run that then fails is still in history", async () => {
  // The loop dies while the first message is being answered: it never reads what was steered in meanwhile.
  const h = await harness({ fail: () => true, delayMs: 60 });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await h.runtime.send(h.session.id, h.say("two"))).queued, true);
    await h.idle();
    const session = await h.store.get(h.session.id);
    assert.equal(session.status, "failed");
    assert.deepEqual(userTexts(session.messages), ["one", "two"], "the accepted message is not lost");
    assert.deepEqual(userTexts(session.context), ["one", "two"]);
    assert.equal(h.events.filter(event => event.type === "message").length, session.messages.length, "and it was announced like any other");
  } finally { await h.close(); }
});

const busy = (h: { runtime: WorkbenchRuntime; session: { id: string } }, on: boolean) => (h.runtime as unknown as { compacting: Set<string> }).compacting[on ? "add" : "delete"](h.session.id);

test("send: the message is on the session before the call returns, and a repeat of its item id is refused", async () => {
  const h = await harness({ delayMs: 120 });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    busy(h, true);
    assert.equal((await h.runtime.send(h.session.id, h.say("two"))).queued, true);
    assert.ok(userTexts((await h.store.get(h.session.id)).queue ?? []).includes("two"), "durable, with its origin item id");
    await assert.rejects(h.runtime.send(h.session.id, h.say("two")), MessageAlreadyAccepted);
    assert.equal(userTexts((await h.store.get(h.session.id)).queue ?? []).filter(text => text === "two").length, 1);
    busy(h, false);
    await h.idle();
    const session = await h.store.get(h.session.id);
    assert.deepEqual(userTexts(session.messages), ["one", "two"]);
    assert.equal(session.queue, undefined, "committed to history, gone from the queue");
  } finally { await h.close(); }
});

test("send: a queued message survives a restart and is processed once", async () => {
  const h = await harness({ delayMs: 150 });
  const restarted = h.build();
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    for (let i = 0; i < 100 && !userTexts((await h.store.get(h.session.id)).messages).includes("one"); i++) await new Promise(resolve => setTimeout(resolve, 5));
    // The first process cannot take the message (it is busy compacting), then it is gone: only the session remembers it.
    busy(h, true);
    assert.equal((await h.runtime.send(h.session.id, h.say("lost?"))).queued, true);
    assert.ok(userTexts((await h.store.get(h.session.id)).queue ?? []).includes("lost?"));
    // A new runtime over the same store: its next run consumes the durable queue first.
    assert.equal((await restarted.send(h.session.id, h.say("after restart"))).queued, false);
    await assert.rejects(restarted.send(h.session.id, h.say("lost?")), MessageAlreadyAccepted);
    for (let i = 0; i < 400 && restarted.isRunning(h.session.id); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const session = await h.store.get(h.session.id);
    assert.deepEqual(userTexts(session.messages).sort(), ["after restart", "lost?", "one"], "each exactly once");
    assert.equal(session.queue, undefined);
  } finally { await restarted.close(); await h.close(); }
});

test("replay: a message that is only queued is found, and the same id with other content conflicts", async () => {
  const h = await harness({ delayMs: 120 });
  try {
    const conversation = new WorkerConversation(WORKERS.byId("research")!, { store: h.store, runtime: h.runtime, entries: async () => [], assertRoleAvailable: async () => undefined });
    const input = (text: string) => ({ id: "item-1", text, attachments: [], client: { client: "cli" as const } });
    await conversation.send({ ...input("first"), id: "item-0" });
    busy(h, true);
    const queuedItems = async () => ((await h.store.get(h.session.id)).queue ?? []).filter(message => (message as { origin?: { itemId?: string } }).origin?.itemId === "item-1").length;
    assert.equal((await conversation.send(input("queued one"))).queued, true);
    assert.equal(await queuedItems(), 1);
    assert.equal((await conversation.send(input("queued one"))).message.id, "item-1");
    assert.equal(await queuedItems(), 1, "no second copy");
    await assert.rejects(conversation.send(input("different")), /idempotency key was used for a different message/);
    busy(h, false);
    await h.idle();
  } finally { await h.close(); }
});

test("send: a message steered into a run that is stopped is still in history", async () => {
  const h = await harness({ delayMs: 120 });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await new Promise(resolve => setTimeout(resolve, 20));
    await h.runtime.send(h.session.id, h.say("two"));
    h.runtime.stop(h.session.id);
    await h.idle();
    assert.deepEqual(userTexts((await h.store.get(h.session.id)).messages), ["one", "two"]);
  } finally { await h.close(); }
});

test("send: a Run starts only while the account is within its cap; one in flight finishes and takes steered messages", async () => {
  const month = emptySurfaces();
  const cap = new UsageCap({ monthToDate: async () => month }, 100, { ttlMs: 0 });
  const h = await harness({ cap, delayMs: 60 });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    month.studio_web.input = 100; // the month is spent while the Run is in flight
    assert.equal((await h.runtime.send(h.session.id, h.say("steer"))).queued, true, "steering into a Run is allowed");
    await h.idle();
    assert.equal((await h.store.get(h.session.id)).status, "completed", "the Run in flight finished");
    assert.deepEqual(userTexts((await h.store.get(h.session.id)).messages), ["one", "steer"]);
    await assert.rejects(h.runtime.send(h.session.id, h.say("next")), (error: unknown) => error instanceof UsageCapExceeded && error.status === 429 && error.code === "usage_cap_exceeded");
    assert.equal(h.runtime.isRunning(h.session.id), false);
    assert.equal(((await h.store.get(h.session.id)).queue ?? []).length, 0, "a refused message is not left queued");
  } finally { await h.close(); }
});

test("send: a message that lands as a Run ends, over the cap, settles the session as failed usage_cap_exceeded and stays for the next send", async () => {
  const month = emptySurfaces();
  const cap = new UsageCap({ monthToDate: async () => month }, 100, { ttlMs: 0 });
  const h = await harness({ cap });
  try {
    await h.runtime.send(h.session.id, h.say("one"));
    await h.idle();
    month.studio_web.input = 100;
    await h.store.enqueue(h.session.id, h.say("late")); // landed as the Run ended
    await (h.runtime as unknown as { resume(id: string): Promise<void> }).resume(h.session.id);
    const session = await h.store.get(h.session.id);
    assert.deepEqual([session.status, session.errorCode, h.runtime.isRunning(h.session.id)], ["failed", "usage_cap_exceeded", false]);
    assert.equal((session.queue ?? []).length, 1, "the message is not lost");
    assert.equal(h.events.at(-1)?.type, "state");
    month.studio_web.input = 0; // the cap was raised or the month reset
    await h.runtime.send(h.session.id, h.say("again"));
    await h.idle();
    const done = await h.store.get(h.session.id);
    assert.equal(done.status, "completed");
    assert.deepEqual(userTexts(done.messages), ["one", "late", "again"], "the held message is answered with the resend");
  } finally { await h.close(); }
});

test("stop: a session left running by a lost process is ended by Stop", async () => {
  const h = await harness({ staleMs: 0 });
  try {
    await h.store.update(h.session.id, s => { s.status = "running"; s.activeTool = "web_search"; });
    await new Promise(resolve => setTimeout(resolve, 5));
    await h.runtime.stop(h.session.id);
    const after = await h.store.get(h.session.id);
    assert.equal(after.status, "interrupted");
    assert.equal(after.activeTool, undefined);
    assert.ok(h.events.some(event => event.type === "run_end"));
  } finally { await h.close(); }
});

test("stop: a Stop that reaches an instance which does not own the Run aborts it through the heartbeat", async () => {
  const h = await harness({ delayMs: 5000, heartbeatMs: 20 });
  try {
    await h.runtime.send(h.session.id, h.say("go"));
    const other = h.build();
    await other.stop(h.session.id);
    await h.idle();
    assert.equal((await h.store.get(h.session.id)).status, "interrupted");
    await other.close();
  } finally { await h.close(); }
});
