import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { BOX_TOOL_CALL_LIMIT } from "./agentBox/tools.js";
import { REPORT_TOOL_CALL_LIMIT } from "./artifact/mode.js";
import { creatorModelToolName } from "./creatorTools.js";
import { InMemoryModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { OutboundMessage, RunStart } from "./protocol.js";
import { renderSkillsSection } from "./skills.js";

/** A model that calls the tool on every request that offers it (up to `callsBeforeText` requests), and speaks otherwise. */
async function runCalling(t: test.TestContext, callsBeforeText: number, toolCallLimit?: RunContext["toolCallLimit"]) {
  const originalKey = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "test-only";
  t.after(() => { if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey; });
  const definition = { id: "probe", description: "probe", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  const requests: Array<{ tools?: unknown[] }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const calls = requests.length;
    const call = calls <= callsBeforeText && body.tools?.length > 0;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name, arguments: '{"activity_message":"x"}' } }] }
      : { role: "assistant", content: "answer from what I have" };
    const chunk = { id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k3.1-pro", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  let executed = 0;
  const input = { type: "client.message", run_id: "run_budget", conversation_id: "conversation_budget", message: { role: "user", content: "go" } } as RunStart;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "go" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    serverTools: { executeCreatorTool: async () => { executed++; return { ok: true }; } },
    ...toolCallLimit ? { toolCallLimit } : {}
  } as unknown as RunContext;
  const events: OutboundMessage[] = [];
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions: [{ type: "function", function: { name, description: "probe", parameters: { type: "object", properties: {}, required: [] } } }] });
  for await (const event of runtime.run(input, ctx)) events.push(event);
  return { requests, executed, events, limited: JSON.stringify(events).includes("tool_call_limit_exceeded") };
}

test("the budgets: a box turn gets the report turn's, report mode keeps its own", () => {
  assert.deepEqual(BOX_TOOL_CALL_LIMIT, { max: 100, uncounted: [] });
  assert.deepEqual(REPORT_TOOL_CALL_LIMIT, { max: 100, uncounted: ["publish_report"] });
});

test("a turn with the box budget may make 20 calls without hitting the limit", async (t) => {
  const { executed, limited, events } = await runCalling(t, 20, BOX_TOOL_CALL_LIMIT);
  assert.equal(executed, 20);
  assert.equal(limited, false);
  assert.ok(events.some((event) => event.type === "turn.completed"));
});

test("a plain chat turn stops at 15 calls, then the model has no tools and answers", async (t) => {
  const { requests, executed, limited, events } = await runCalling(t, 100);
  assert.equal(executed, 15);
  assert.equal(limited, true);
  assert.ok(requests.slice(0, 16).every((request) => request.tools?.length), "tools were offered up to the refused call");
  assert.ok(!requests.at(-1)!.tools?.length, "the call after the limit result carries no tools");
  assert.equal(requests.length, 17, "15 calls, the one refused call, then the answer");
  assert.ok(events.some((event) => event.type === "assistant.delta" && event.delta.kind === "text"));
  assert.ok(events.some((event) => event.type === "turn.completed"));
});
