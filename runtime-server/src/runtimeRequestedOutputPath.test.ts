import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
import { requestedOutputPath } from "./agentRuntime.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import { KIMI_MODEL } from "./piModel.js";
import { RunStateMachine } from "./runState.js";
import { ServerToolExecutor } from "./serverTools.js";
import { RuntimeStore } from "./store.js";

test("requestedOutputPath does not confuse rewrite/what prose with a file request", () => {
  assert.equal(requestedOutputPath(
    "Rewrite this answer, or tell me exactly what you need from me first."
  ), undefined);
  assert.equal(requestedOutputPath(
    "A customer submits the following for a rewrite. What you return must be ready to say."
  ), undefined);
});

test("requestedOutputPath still recognizes explicit safe output paths", () => {
  assert.equal(requestedOutputPath("Save the answer to output.md"), "output.md");
  assert.equal(requestedOutputPath("Write the result as artifacts/final.md"), "artifacts/final.md");
  assert.equal(requestedOutputPath("保存到 result.md"), "result.md");
  assert.equal(requestedOutputPath("Save the answer to ../outside.md"), undefined);
});

test("Pi Runtime completes rewrite prose inline when the session has no fs.write capability", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "hatch-output-path-test-"));
  const previousKey = process.env.LLM_API_KEY;
  const previousBaseUrl = process.env.OPENAI_BASE_URL;
  const previousFetch = globalThis.fetch;
  t.after(async () => {
    if (previousKey === undefined) delete process.env.LLM_API_KEY;
    else process.env.LLM_API_KEY = previousKey;
    if (previousBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previousBaseUrl;
    globalThis.fetch = previousFetch;
    await rm(scratch, { recursive: true, force: true });
  });

  process.env.LLM_API_KEY = "runtime-output-path-test-key";
  process.env.OPENAI_BASE_URL = "http://127.0.0.1:18191/v1";
  globalThis.fetch = async () => {
    const chunks = [
      {
        id: "chatcmpl-output-path",
        object: "chat.completion.chunk",
        created: 1,
        model: KIMI_MODEL,
        choices: [{ index: 0, delta: { role: "assistant", content: "INLINE_REWRITE" }, finish_reason: null }]
      },
      {
        id: "chatcmpl-output-path",
        object: "chat.completion.chunk",
        created: 1,
        model: KIMI_MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }
      }
    ];
    return new Response(`${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`, {
      status: 200,
      headers: { "content-type": "text/event-stream" }
    });
  };

  const runId = "runtime-output-path";
  const conversationId = "runtime-output-path-conversation";
  const store = new RuntimeStore(scratch);
  const state = new RunStateMachine(runId, conversationId, store);
  let clientToolRequests = 0;
  const broker = new ClientToolBroker(async () => {
    clientToolRequests += 1;
    throw new Error("No client tools are available");
  }, store);
  await state.queued();
  await state.start();

  const question = "Rewrite this answer, or tell me exactly what you need from me first.";
  const events = [];
  for await (const event of new PiAgentRuntime().run({
    type: "client.message",
    run_id: runId,
    client_message_id: runId,
    conversation_id: conversationId,
    message: { role: "user", content: question }
  }, {
    clientBroker: broker,
    serverTools: new ServerToolExecutor(),
    state,
    messages: [{ role: "user", content: question }],
    sessionSkills: {
      records: [],
      visibleRecords: [],
      rendered: {
        section: "",
        aliases: {},
        report: {
          total_count: 0,
          included_count: 0,
          omitted_count: 0,
          truncated_description_chars: 0,
          truncated_description_count: 0
        }
      }
    },
    clientTools: [],
    allowedExternalTools: [],
    externalToolDefinitions: [],
    allowSkillRun: false,
    knowledgeAvailable: false,
    agentSystemPrompt: "Return the rewritten answer inline."
  })) events.push(event);

  assert.equal(clientToolRequests, 0);
  assert.ok(events.some((event) => event.type === "turn.completed"));
  assert.equal(events.some((event) => event.type === "tool_call.delta" && event.name === "fs.write"), false);
  assert.match(JSON.stringify(events), /INLINE_REWRITE/);
});
