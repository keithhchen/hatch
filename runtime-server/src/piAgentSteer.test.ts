import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { creatorModelToolName } from "./creatorTools.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { ConversationMessage, OutboundMessage, RunStart } from "./protocol.js";
import { renderSkillsSection } from "./skills.js";

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const sse = (body: BodyInit) => new Response(body, { headers: { "content-type": "text/event-stream" } });
const whole = (delta: Record<string, unknown>, finish: string) => sse(`${chunk(delta, finish)}data: [DONE]\n\n`);

/** A stream that writes `written` and then stalls until the request is aborted, like a long generation. */
function stalling(written: string, init: RequestInit): Response {
  const encoder = new TextEncoder();
  return sse(new ReadableStream({
    start(controller) {
      if (written) controller.enqueue(encoder.encode(chunk({ role: "assistant", content: written })));
      init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
    }
  }));
}

function environment(t: test.TestContext) {
  const saved = [process.env.HATCH_LLM_PROFILE, process.env.LLM_API_KEY];
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "test-only";
  t.after(() => {
    for (const [name, value] of [["HATCH_LLM_PROFILE", saved[0]], ["LLM_API_KEY", saved[1]]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
}

const input = { type: "client.message", run_id: "run_steer", conversation_id: "conversation_steer", message: { role: "user", content: "写一篇长文" } } as RunStart;

function contextWith(extra: Partial<RunContext>, joined: ConversationMessage[]) {
  const wakes: Array<() => void> = [];
  let claims = 0;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "写一篇长文" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    claimSteered: async () => { claims++; return joined.splice(0); },
    onSteer: (listener: () => void) => { wakes.push(listener); return () => undefined; },
    ...extra
  } as unknown as RunContext;
  return { ctx, wake: () => wakes.forEach((wake) => wake()), claims: () => claims };
}

test("A message that joins mid-stream cuts the call and keeps what was written as the reply; the message stays unclaimed", async (t) => {
  environment(t);
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { bodies.push(String(init.body)); return stalling("写了一半", init); });
  const joined: ConversationMessage[] = [{ role: "user", content: "补充一句" }];
  const { ctx, wake, claims } = contextWith({}, joined);
  const events: OutboundMessage[] = [];
  for await (const event of new PiAgentRuntime().run(input, ctx)) {
    events.push(event);
    if (event.type === "assistant.delta" && event.delta.kind === "text") wake();
  }
  assert.equal(bodies.length, 1, "no second model call here: Chat runs again from the unclaimed message");
  assert.equal(claims(), 0);
  assert.equal(joined.length, 1);
  assert.deepEqual(events.filter((event) => event.type === "assistant.delta" && event.delta.kind === "text").map((event) => (event as { delta: { content: string } }).delta.content), ["写了一半"]);
  assert.ok(events.some((event) => event.type === "turn.completed"), JSON.stringify(events.map((event) => event.type)));
});

test("A message that joins before the call has written anything is read by a fresh call in the same Run", async (t) => {
  environment(t);
  const bodies: string[] = [];
  let wake = (): void => undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) { setTimeout(() => wake(), 20); return stalling("", init); }
    return whole({ role: "assistant", content: "一个回答" }, "stop");
  });
  const joined: ConversationMessage[] = [{ role: "user", content: "其实我想问别的" }];
  const harness = contextWith({}, joined);
  wake = harness.wake;
  const events: OutboundMessage[] = [];
  for await (const event of new PiAgentRuntime().run(input, harness.ctx)) events.push(event);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /其实我想问别的/);
  assert.match(bodies[1], /写一篇长文/);
  assert.equal(joined.length, 0);
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("A message that joins while a tool executes waits for the tool, then is read before the next call", async (t) => {
  environment(t);
  const definition = { id: "slow", description: "slow", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    return bodies.length === 1
      ? whole({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: '{"activity_message":"x"}' } }] }, "tool_calls")
      : whole({ role: "assistant", content: "之后的回答" }, "stop");
  });
  const joined: ConversationMessage[] = [];
  let toolFinished = false;
  const holder: { wake?: () => void } = {};
  const harness = contextWith({
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    serverTools: { executeCreatorTool: async () => {
      joined.push({ role: "user", content: "工具运行时的新消息" });
      holder.wake?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
      toolFinished = true;
      return { ok: true };
    } }
  } as unknown as Partial<RunContext>, joined);
  holder.wake = harness.wake;
  const runtime = new PiAgentRuntime({ toolDefinitions: [{ type: "function", function: { name, description: "slow", parameters: { type: "object", properties: {}, required: [] } } }] });
  const events: OutboundMessage[] = [];
  for await (const event of runtime.run(input, harness.ctx)) events.push(event);
  assert.ok(toolFinished);
  assert.ok(events.some((event) => event.type === "tool_call.delta" && event.status === "completed"), "the tool was not cut");
  assert.equal(bodies.length, 2);
  assert.match(bodies[1], /工具运行时的新消息/);
  assert.equal(joined.length, 0, "claimed at the turn end, as before");
});

test("A call cut while thinking ends its thinking block, so the next call may start block 0 again", async (t) => {
  environment(t);
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6";
  const encoder = new TextEncoder();
  const bodies: string[] = [];
  let wake = (): void => undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    if (bodies.length === 1) {
      setTimeout(() => wake(), 20);
      return sse(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant", reasoning_content: "想了一半" })));
          init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
        }
      }));
    }
    return sse(`${chunk({ role: "assistant", reasoning_content: "重新想" })}${chunk({ content: "一个回答" }, "stop")}data: [DONE]\n\n`);
  });
  const harness = contextWith({}, [{ role: "user", content: "其实我想问别的" }]);
  wake = harness.wake;
  const events: OutboundMessage[] = [];
  for await (const event of new PiAgentRuntime().run(input, harness.ctx)) events.push(event);
  const thinking = events.flatMap((event) => event.type === "assistant.delta" && event.delta.kind.startsWith("thinking_") ? [`${event.delta.kind}:${(event.delta as { contentIndex: number }).contentIndex}`] : []);
  assert.equal(bodies.length, 2);
  assert.deepEqual(thinking.filter((kind) => !kind.startsWith("thinking_delta")), ["thinking_start:0", "thinking_end:0", "thinking_start:0", "thinking_end:0"]);
  assert.ok(events.some((event) => event.type === "turn.completed"), JSON.stringify(events.map((event) => event.type)));
});
