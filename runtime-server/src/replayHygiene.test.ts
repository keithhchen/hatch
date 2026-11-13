import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { creatorModelToolName } from "./creatorTools.js";
import { InMemoryModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { ConversationMessage, OutboundMessage, RunStart } from "./protocol.js";
import { withoutEarlierReasoning } from "./replayHygiene.js";
import { renderSkillsSection } from "./skills.js";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const assistant = (content: unknown[]) => ({ role: "assistant", content, api: "openai-completions", provider: "p", model: "m", stopReason: "stop", timestamp: 1 }) as unknown as AgentMessage;

test("earlier turns lose thinking and signatures; the current turn and stored messages are untouched", () => {
  const old = assistant([
    { type: "thinking", thinking: "old thought", thinkingSignature: "reasoning_content" },
    { type: "text", text: "said", textSignature: "sig" },
    { type: "toolCall", id: "c1", name: "t", arguments: {}, thoughtSignature: "AAAA" }
  ]);
  const onlyThought = assistant([{ type: "thinking", thinking: "x" }]);
  const current = assistant([{ type: "thinking", thinking: "now", thinkingSignature: "reasoning_content" }, { type: "toolCall", id: "c2", name: "t", arguments: {}, thoughtSignature: "BBBB" }]);
  const user = { role: "user", content: "hi", timestamp: 1 } as AgentMessage;
  const out = withoutEarlierReasoning([user, old, onlyThought, user, current], new Set([user, old, onlyThought]));
  assert.equal(out.length, 4, "an assistant message that was only thought is dropped");
  assert.deepEqual((out[1] as { content: unknown[] }).content, [{ type: "text", text: "said" }, { type: "toolCall", id: "c1", name: "t", arguments: {} }]);
  assert.equal(out[3], current);
  assert.equal((old as { content: Array<{ type: string }> }).content[0]!.type, "thinking", "the stored message is not mutated");
});

test("a request replays no reasoning of finished turns, and the current tool loop keeps its own", async (t) => {
  process.env.LLM_API_KEY = "test-only";
  t.after(() => { delete process.env.LLM_API_KEY; });
  const definition = { id: "look", description: "look", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const first = requests.length === 1;
    const delta = first
      ? { role: "assistant", reasoning_content: "CURRENT-THOUGHT", tool_calls: [{ index: 0, id: "call_now", type: "function", function: { name, arguments: "{}" } }] }
      : { role: "assistant", content: "done" };
    const chunk = { id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k3.1-pro", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const earlier: ConversationMessage = {
    role: "assistant", content: "earlier answer", model_api: "openai-completions", model_provider: "moonshot", model_id: "kimi-k3.1-pro",
    model_content: [{ type: "thinking", thinking: "OLD-THOUGHT", thinkingSignature: "reasoning_content" }, { type: "text", text: "earlier answer" }]
  } as ConversationMessage;
  const input = { type: "client.message", run_id: "r", conversation_id: "c", message: { role: "user", content: "now" } } as RunStart;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "before" }, earlier, { role: "user", content: "now" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    serverTools: { executeCreatorTool: async () => ({ ok: true }) }
  } as unknown as RunContext;
  const events: OutboundMessage[] = [];
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions: [{ type: "function", function: { name, description: "look", parameters: { type: "object", properties: {}, required: [] } } }] });
  for await (const event of runtime.run(input, ctx)) events.push(event);
  assert.equal(requests.length, 2);
  for (const request of requests) assert.doesNotMatch(JSON.stringify(request), /OLD-THOUGHT/);
  assert.match(JSON.stringify(requests[0]), /earlier answer/);
  assert.match(JSON.stringify(requests[1]), /CURRENT-THOUGHT/, "the loop of the running turn replays its own reasoning");
});

test("liveState is read once per Run however many model calls it makes", async (t) => {
  process.env.LLM_API_KEY = "test-only";
  t.after(() => { delete process.env.LLM_API_KEY; });
  const definition = { id: "look", description: "look", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  let calls = 0;
  const bodies: string[] = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body));
    const toolTurn = bodies.length < 4;
    const delta = toolTurn ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${bodies.length}`, type: "function", function: { name, arguments: "{}" } }] } : { role: "assistant", content: "done" };
    const chunk = { id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k3.1-pro", choices: [{ index: 0, delta, finish_reason: toolTurn ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const input = { type: "client.message", run_id: "r", conversation_id: "c", message: { role: "user", content: "go" } } as RunStart;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "go" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    serverTools: { executeCreatorTool: async () => ({ ok: true }) },
    liveState: async () => { calls++; return "<当前状态>LIVE</当前状态>"; }
  } as unknown as RunContext;
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions: [{ type: "function", function: { name, description: "look", parameters: { type: "object", properties: {}, required: [] } } }] });
  for await (const _event of runtime.run(input, ctx)) { /* drained */ }
  assert.equal(bodies.length, 4);
  assert.equal(calls, 1);
  for (const body of bodies) assert.match(body, /LIVE/, "every call still carries the state");
});
