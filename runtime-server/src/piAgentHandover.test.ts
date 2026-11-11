import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { creatorModelToolName } from "./creatorTools.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { ConversationMessage, OutboundMessage, RunStart } from "./protocol.js";
import { renderSkillsSection } from "./skills.js";

/** The provider's reply: one tool call on the first request, a spoken line on any later one. */
function toolThenText(requests: unknown[], toolName: string) {
  return async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)).messages);
    const first = requests.length === 1;
    const delta = first
      ? { role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: toolName, arguments: '{"activity_message":"请对方接着聊"}' } }] }
      : { role: "assistant", content: "后来的话" };
    const chunk = { id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k2.6", choices: [{ index: 0, delta, finish_reason: first ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  };
}

/** A Run whose one tool call is the moment the Expert's next message joins it. */
async function runWithJoiningMessage(t: test.TestContext, toolResult: Record<string, unknown>) {
  const originalProfile = process.env.HATCH_LLM_PROFILE;
  const originalKey = process.env.LLM_API_KEY;
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "test-only";
  t.after(() => {
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE; else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey;
  });
  const definition = { id: "handover", description: "hand over", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  const requests: unknown[] = [];
  t.mock.method(globalThis, "fetch", toolThenText(requests, name));
  const waiting: ConversationMessage[] = [];
  const input = { type: "client.message", run_id: "run_handover", conversation_id: "conversation_handover", message: { role: "user", content: "开始" } } as RunStart;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "开始" }], clientTools: [], mayStaySilent: true,
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    serverTools: { executeCreatorTool: async () => { waiting.push({ role: "user", content: "不对，我不是他" }); return toolResult; } },
    claimSteered: async () => waiting.splice(0)
  } as unknown as RunContext;
  const events: OutboundMessage[] = [];
  const runtime = new PiAgentRuntime({ toolDefinitions: [{ type: "function", function: { name, description: "hand over", parameters: { type: "object", properties: {}, required: [] } } }] });
  for await (const event of runtime.run(input, ctx)) events.push(event);
  return { requests, waiting, events };
}

test("A message that joins after a tool handed the conversation over is not read by the model: it stays for the next Run", async (t) => {
  const { requests, waiting, events } = await runWithJoiningMessage(t, { ends_turn: true, ok: true });
  assert.equal(requests.length, 1, "the model was not called again after the hand-over");
  assert.deepEqual(waiting.map((message) => message.content), ["不对，我不是他"], "left unclaimed, Chat runs it again and it reaches the new owner");
  assert.ok(events.some((event) => event.type === "turn.completed"), JSON.stringify(events.map((event) => event.type)));
  assert.ok(!events.some((event) => event.type === "assistant.delta" && event.delta.kind === "text"), "the Run says nothing");
});

test("Without a hand-over a message that joins the Run is read by the model before its next call", async (t) => {
  const { requests, waiting, events } = await runWithJoiningMessage(t, { ok: true });
  assert.equal(requests.length, 2);
  assert.match(JSON.stringify(requests[1]), /不对，我不是他/);
  assert.equal(waiting.length, 0);
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.delta.kind === "text"));
});
