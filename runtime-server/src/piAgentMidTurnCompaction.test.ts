import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { chatCompactionStrategy } from "./compaction.js";
import { creatorModelToolName } from "./creatorTools.js";
import { llmProfile } from "./llmProfiles.js";
import { InMemoryModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { OutboundMessage, RunStart } from "./protocol.js";
import { renderSkillsSection } from "./skills.js";

/**
 * A long Run whose tool results cross the summary trigger several times. Pi keeps its own transcript and only sends what
 * `transformContext` returns, so a summary taken between tool steps must carry over to the next step: otherwise every step
 * after the first crossing summarizes the whole Run again.
 */
async function longRun(t: test.TestContext, toolCalls: number) {
  const originalKey = process.env.LLM_API_KEY;
  process.env.LLM_API_KEY = "test-only";
  t.after(() => { if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey; });
  const definition = { id: "read_record", description: "read", input_schema: { type: "object", properties: {} } };
  const name = creatorModelToolName(definition.id);
  const requests: Array<{ messages: Array<{ role: string; content?: unknown }> }> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    requests.push(body);
    const call = requests.length <= toolCalls;
    const delta = call
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name, arguments: '{"activity_message":"x"}' } }] }
      : { role: "assistant", content: "report done" };
    const chunk = { id: "t", object: "chat.completion.chunk", created: 1, model: "kimi-k3.1-pro", choices: [{ index: 0, delta, finish_reason: call ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  });
  const summaries: Array<{ messages: number; previous?: string }> = [];
  // Each result is about 1.5k tokens; the trigger is 4k and the tail 1k, so the Run crosses the trigger again every few calls.
  const strategy = chatCompactionStrategy(llmProfile("kimi-k3.1-pro"), {
    budget: { trigger: 4_000, hard: 4_000, prune: 1_000_000, tail: 1_000 },
    summarize: async ({ messages, previous }) => { summaries.push({ messages: messages.length, previous }); return `summary ${summaries.length} of call_ ids`; }
  });
  let executed = 0;
  const input = { type: "client.message", run_id: "run_long", conversation_id: "conversation_long", message: { role: "user", content: "write the report" } } as RunStart;
  const ctx = {
    state: { status: "running" }, messages: [{ role: "user", content: "write the report" }], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    externalToolDefinitions: [definition], allowedExternalTools: [name],
    toolCallLimit: { max: 100, uncounted: [] },
    serverTools: { executeCreatorTool: async () => { executed++; return { ok: true, record: `record ${executed} `.repeat(600) }; } },
    compactMessagesIfNeeded: async (messages: Parameters<NonNullable<RunContext["compactMessagesIfNeeded"]>>[0]) => {
      const outcome = await strategy.compact(messages, { now: Date.now(), cacheTouchedAt: Date.now(), signal: new AbortController().signal });
      return outcome.kind === "none" ? undefined : outcome.messages as never;
    }
  } as unknown as RunContext;
  const events: OutboundMessage[] = [];
  const runtime = new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions: [{ type: "function", function: { name, description: "read", parameters: { type: "object", properties: {}, required: [] } } }] });
  for await (const event of runtime.run(input, ctx)) events.push(event);
  return { requests, summaries, executed, events, strategy };
}

test("a long Run summarizes only when its context crosses the trigger again, each summary building on the one before", async (t) => {
  const { requests, summaries, executed, events, strategy } = await longRun(t, 12);
  assert.equal(executed, 12);
  assert.ok(events.some((event) => event.type === "turn.completed"), "the Run finished");
  // 12 results of ~1.5k against a 4k trigger and a 1k tail: a summary every two or three calls, never one per call.
  assert.ok(summaries.length >= 2, `it summarized ${summaries.length} times`);
  assert.ok(summaries.length <= 6, `it summarized ${summaries.length} times for 12 tool calls: the summary did not carry over`);
  // Only the first summary (and its one retry for missing details) starts from nothing; every later one extends the one before.
  assert.ok(summaries.filter((summary) => !summary.previous).length <= 2, JSON.stringify(summaries));
  assert.ok(summaries.at(-1)!.previous?.startsWith("summary "), "the last summary extends the one before");
  // Every request after the first summary stays near the trigger: the summarized results are not sent again.
  const sizes = requests.map((request) => JSON.stringify(request.messages).length);
  const last = requests.at(-1)!;
  assert.ok(JSON.stringify(last.messages).includes("summary "), "the last request carries the latest summary");
  assert.ok(!JSON.stringify(last.messages).includes("record 1 record 1"), "the first record is not sent again");
  assert.ok(Math.max(...sizes.slice(4)) < 4 * strategy.policy.trigger * 2, `request sizes stayed bounded: ${sizes.join(",")}`);
});
