import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatRuntime } from "./chatRuntime.js";
import type { ToolRequest, ToolResult } from "../protocol.js";

const result = (id: string) => ({ type: "tool_call.result", run_id: "run-1", tool_call_id: id, status: "ok", result: {} }) as ToolResult;
const pending = (id: string) => ({ type: "tool_call.request", run_id: "run-1", tool_call_id: id, name: "shell_exec", arguments: {}, approval: "none" }) as unknown as ToolRequest;

/** A runtime over a supervisor that holds one waiting call and answers only a call it was given. */
function runtime(delivered: boolean, cancelled: boolean) {
  const calls: string[] = [];
  const chat = Object.assign(Object.create(ChatRuntime.prototype) as ChatRuntime<unknown>, {
    supervisor: {
      deliverToolResult: async (_c: string, _r: string, r: ToolResult) => { calls.push(r.tool_call_id); return delivered; },
      cancel: async () => cancelled
    },
    pendingToolRequests: async () => [pending("t1")]
  });
  return { chat, calls };
}

test("answerTool delivers an answer from a client that may run the tool", async () => {
  const { chat, calls } = runtime(true, false);
  assert.deepEqual(await chat.answerTool("c", result("t1"), "desktop"), { outcome: "accepted" });
  assert.deepEqual(calls, ["t1"]);
});

test("answerTool refuses a client that may not answer, and delivers nothing", async () => {
  const { chat, calls } = runtime(true, false);
  const answer = await chat.answerTool("c", result("t1"), "im");
  assert.equal(answer.outcome, "forbidden");
  assert.equal(answer.outcome === "forbidden" && answer.error.code, "tool_unsupported_on_client");
  assert.deepEqual(calls, []);
});

test("answerTool says unknown when nothing waits for the answer", async () => {
  const { chat } = runtime(false, false);
  assert.deepEqual(await chat.answerTool("c", result("t9"), "desktop"), { outcome: "unknown", error: { code: "unknown_tool_call", message: "No pending tool request for t9" } });
});

test("cancel tells a stopped Run from an unknown one", async () => {
  assert.deepEqual(await runtime(false, true).chat.cancel("c", "run-1", "stop"), { outcome: "cancelled" });
  assert.deepEqual(await runtime(false, false).chat.cancel("c", "run-2", "stop"), { outcome: "unknown", error: { code: "unknown_run", message: "No active run for run-2" } });
});
