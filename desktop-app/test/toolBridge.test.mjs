import assert from "node:assert/strict";
import test from "node:test";
import { handleLocalToolRequest } from "../src/renderer/toolBridge.js";

function request(approval = "auto") {
  return {
    type: "tool_call.request",
    run_id: "run_renderer_test",
    tool_call_id: "call_renderer_test",
    name: "fs.list",
    arguments: { path: "." },
    approval
  };
}

function dependencies(overrides = {}) {
  const calls = { invoke: [], sent: [], traces: [], events: [] };
  const deps = {
    workspaceRoot: "/workspace",
    timeoutMs: 100,
    invokeTauri: async (command, args) => {
      calls.invoke.push({ command, args });
      return { type: "tool_call.result", status: "ok", result: { entries: [] } };
    },
    withTimeout: (promise) => promise,
    send: (message) => {
      calls.sent.push(message);
      return true;
    },
    upsertToolEvent: (event) => calls.events.push(event),
    recordTrace: (phase, status, correlationId) => calls.traces.push({ phase, status, correlationId }),
    errorMessage: (error) => error instanceof Error ? error.message : String(error),
    ...overrides
  };
  return { deps, calls };
}

test("tool_call.request enters Tauri invoke and sends result", async () => {
  const { deps, calls } = dependencies();
  await handleLocalToolRequest(request(), deps);

  assert.equal(calls.invoke.length, 1);
  assert.equal(calls.invoke[0].command, "execute_tool_call");
  assert.equal(calls.invoke[0].args.workspaceRoot, "/workspace");
  assert.equal(calls.sent[0].status, "ok");
  assert.deepEqual(calls.traces.map(({ phase }) => phase), [
    "tool_request.handle.enter",
    "invoke.start",
    "invoke.result",
    "ws.send"
  ]);
});

test("max-permission request with ask metadata does not wait for UI approval", async () => {
  const { deps, calls } = dependencies();
  await handleLocalToolRequest(request("ask"), deps);

  assert.equal(calls.invoke.length, 1);
  assert.ok(calls.traces.some(({ phase, status }) => phase === "approval.bypassed" && status === "max_permission"));
  assert.equal(calls.sent[0].status, "ok");
});

test("invoke failure returns a controlled tool result", async () => {
  const { deps, calls } = dependencies({
    invokeTauri: async () => {
      throw new Error("invoke failed");
    }
  });
  await handleLocalToolRequest(request(), deps);

  assert.equal(calls.sent[0].status, "error");
  assert.equal(calls.sent[0].error.code, "local_runner_error");
  assert.equal(calls.events[0].status, "failed");
  assert.ok(calls.traces.some(({ phase, status }) => phase === "invoke.error" && status === "error"));
});
