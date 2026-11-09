import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { createFactoryLlmModel } from "../creatorLearning/factoryPi.js";
import { userMessage } from "./imageRefs.js";
import { MemoryAgentDefinitionRepository, initialAgentDefinitions } from "./definitions.js";
import { WorkbenchRuntime } from "./runtime.js";
import { WorkbenchStore } from "./store.js";

type Call = { tools: Array<{ name: string; description: string }>; last: string };

/** Real store and runtime; only the model is scripted. `plan(call)` is the tool the model calls, if any. */
async function harness(options: { plan?: (call: number) => string | undefined; toolSupport?: (name: string) => readonly ("web" | "cli")[] | "*"; delayMs?: number } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hatch-send-"));
  const store = new WorkbenchStore(root, { creatorId: "c1", productId: "p1" }, new MemoryAgentDefinitionRepository(await initialAgentDefinitions()));
  const calls: Call[] = [];
  const runtime = new WorkbenchRuntime(store, {
    env: { HATCH_FACTORY_LLM_PROFILE: "deepseek-v4-flash" },
    toolSupport: options.toolSupport as never,
    agentFactory: factory => new Agent({ ...factory.agentOptions, initialState: { ...factory.initialState, model: createFactoryLlmModel({ env: factory.env }) }, streamFn: (_model, context) => {
      const call = calls.length + 1;
      const final = context.messages.at(-1);
      calls.push({ tools: (context.tools ?? []).map(tool => ({ name: tool.name, description: tool.description })), last: JSON.stringify(final?.content) });
      const tool = options.plan?.(call);
      const message: AssistantMessage = { role: "assistant", api: "openai-completions", provider: "moonshotai-cn", model: "kimi-k2.6", timestamp: Date.now(),
        content: tool ? [{ type: "toolCall", id: `call-${call}`, name: tool, arguments: { directory: "input" } }] : [{ type: "text", text: `Reply ${call}` }],
        stopReason: tool ? "toolUse" : "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream();
      setTimeout(() => { stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: tool ? "toolUse" : "stop", message }); stream.end(message); }, options.delayMs ?? 30);
      return stream;
    } }),
  });
  const events: Array<{ type: string; sessionId?: string }> = [];
  runtime.events.on("event", event => events.push(event));
  const session = await store.create("research");
  const say = (text: string) => userMessage(text, [], { kind: "expert", itemId: text, text });
  const idle = async () => { for (let i = 0; i < 400; i++) { if (!runtime.isRunning(session.id)) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error("run did not end"); };
  return { runtime, store, session, calls, events, say, idle, close: async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); } };
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
    const internals = h.runtime as unknown as { compacting: Set<string>; release(id: string): void; held: Map<string, AgentMessage[]> };
    internals.compacting.add(h.session.id);
    assert.equal((await h.runtime.send(h.session.id, h.say("during"))).queued, true);
    assert.equal(internals.held.get(h.session.id)?.length, 1, "held, not injected");
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
