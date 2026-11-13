import assert from "node:assert/strict";
import test from "node:test";
import { WebChatCapabilityPolicy } from "../webChatRuntimeBridge.mjs";

test("Web Chat passes the browser's approval refusal to the Runtime instead of closing the socket", () => {
  const policy = new WebChatCapabilityPolicy();
  assert.deepEqual(policy.prepare({ type: "tool_call.result", run_id: "run", tool_call_id: "tool", status: "error", error: { code: "browser_approval_unavailable", message: "client text" } }, true, "token"), {
    type: "tool_call.result", run_id: "run", tool_call_id: "tool", status: "error", error: { code: "browser_approval_unavailable", message: "此浏览器不能批准工具调用。" }
  });
  assert.throws(() => policy.prepare({ type: "tool_call.result", run_id: "run", tool_call_id: "tool", status: "error", error: { code: "other" } }, true, "token"), /Unsupported client message/);
});
