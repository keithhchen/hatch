import assert from "node:assert/strict";
import test from "node:test";
import type { RunContext } from "./agentRuntime.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { TASK_START_MESSAGE_CONTENT, type RunStart } from "./protocol.js";

test("task_start keeps its marked history turn while omitting the marker from the provider request", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  const originalProfile = process.env.HATCH_LLM_PROFILE;
  const originalApiKey = process.env.LLM_API_KEY;
  process.env.HATCH_LLM_PROFILE = "kimi-k2.6-no-thinking";
  process.env.LLM_API_KEY = "task-start-test-key";
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const chunks = [
      {
        id: "chatcmpl-task-start",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: { role: "assistant", content: "Task started." }, finish_reason: null }]
      },
      {
        id: "chatcmpl-task-start",
        object: "chat.completion.chunk",
        created: 1,
        model: "kimi-k2.6",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
      }
    ];
    const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  }) as typeof globalThis.fetch;

  try {
    const input = {
      type: "client.message",
      run_id: "run_task_start",
      conversation_id: "conversation_task_start",
      task_start: true,
      message: { role: "user", content: TASK_START_MESSAGE_CONTENT }
    } as RunStart;
    const events = [];
    const runtime = new PiAgentRuntime({ toolDefinitions: [] });
    for await (const event of runtime.run(input, {
      state: { status: "running" },
      // The current marked row is part of the canonical assembled history.
      messages: [{ role: "user", content: TASK_START_MESSAGE_CONTENT, kind: "task_start" }],
      sessionSkills: {
        records: [],
        visibleRecords: [],
        rendered: {
          section: "Available runtime guidance.",
          report: {
            total_count: 1,
            included_count: 1,
            omitted_count: 0,
            truncated_description_chars: 0,
            truncated_description_count: 0
          },
          aliases: {}
        }
      },
      clientTools: []
    } as unknown as RunContext)) {
      events.push(event);
    }

    assert.ok(events.some((event) => event.type === "turn.completed"));
    assert.equal(requests.length, 1);
    const messages = requests[0]?.messages;
    assert.ok(Array.isArray(messages));
    const userMessages = messages.filter((message) => message && typeof message === "object" && message.role === "user");
    assert.ok(userMessages.length > 0);
    assert.ok(userMessages.every((message) => typeof message.content === "string" && message.content.trim().length > 0));
    assert.equal(userMessages.at(-1)?.content, TASK_START_MESSAGE_CONTENT);
    assert.ok(userMessages.every((message) => !("kind" in message)));
  } finally {
    globalThis.fetch = originalFetch;
    if (originalProfile === undefined) delete process.env.HATCH_LLM_PROFILE;
    else process.env.HATCH_LLM_PROFILE = originalProfile;
    if (originalApiKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = originalApiKey;
  }
});
