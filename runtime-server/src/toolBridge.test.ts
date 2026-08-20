import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientToolBroker } from "./clientBroker.js";
import type { RunStateMachine } from "./runState.js";
import type { RuntimeStore } from "./store.js";
import { ServerToolExecutor } from "./serverTools.js";
import { ToolBridge } from "./toolBridge.js";

const state = undefined as unknown as RunStateMachine;

test("ToolBridge routes local tools with correlation intact", async () => {
  const localCalls: unknown[] = [];
  const serverCalls: unknown[] = [];
  const broker = {
    execute: async (...args: unknown[]) => {
      localCalls.push(args);
      return { content: "local result" };
    }
  } as unknown as ClientToolBroker;
  const serverTools = {
    execute: async (...args: unknown[]) => {
      serverCalls.push(args);
      return { content: "server result" };
    }
  } as unknown as ServerToolExecutor;
  const bridge = new ToolBridge(broker, serverTools);

  assert.deepEqual(await bridge.execute({
    runId: "run_main",
    toolCallId: "call_main",
    name: "file_read",
    arguments: { path: "notes.txt" },
    clientTools: ["file_read"],
    state
  }), { content: "local result" });
  assert.deepEqual(await bridge.execute({
    runId: "run_parent",
    toolCallId: "call_skill",
    name: "file_read",
    arguments: { path: "notes.txt" },
    clientTools: ["file_read"],
    state
  }), { content: "local result" });

  assert.deepEqual(localCalls, [
    ["run_main", "file_read", { path: "notes.txt" }, state, "call_main"],
    ["run_parent", "file_read", { path: "notes.txt" }, state, "call_skill"]
  ]);
  assert.deepEqual(serverCalls, []);
});

test("ToolBridge routes server tools without sending them to the client broker", async () => {
  const broker = {
    execute: async () => {
      throw new Error("server tool was incorrectly routed to client");
    }
  } as unknown as ClientToolBroker;
  const serverCalls: unknown[] = [];
  const serverTools = {
    execute: async (...args: unknown[]) => {
      serverCalls.push(args);
      return { status: "ok" };
    }
  } as unknown as ServerToolExecutor;
  const bridge = new ToolBridge(broker, serverTools);
  const controller = new AbortController();

  const result = await bridge.execute({
    runId: "run_server",
    toolCallId: "call_http",
    name: "api.request",
    arguments: { endpoint: "policy.lookup", payload: { region: "us" } },
    clientTools: [],
    state,
    signal: controller.signal
  });

  assert.deepEqual(result, { status: "ok" });
  assert.deepEqual(serverCalls, [["api.request", {
    endpoint: "policy.lookup",
    payload: { region: "us" }
  }, controller.signal]]);
});

test("ToolBridge rejects invalid schemas and unavailable local capabilities before dispatch", async () => {
  let dispatches = 0;
  const broker = {
    execute: async () => {
      dispatches += 1;
      return {};
    }
  } as unknown as ClientToolBroker;
  const serverTools = { execute: async () => ({}) } as unknown as ServerToolExecutor;
  const bridge = new ToolBridge(broker, serverTools);

  await assert.rejects(() => bridge.execute({
    runId: "run_invalid",
    toolCallId: "call_invalid",
    name: "file_read",
    arguments: {},
    clientTools: ["file_read"],
    state
  }));
  await assert.rejects(() => bridge.execute({
    runId: "run_disabled",
    toolCallId: "call_disabled",
    name: "file_read",
    arguments: { path: "notes.txt" },
    clientTools: [],
    state
  }), /not enabled/);
  assert.equal(dispatches, 0);
});

test("ToolBridge preserves cancellation ownership and ignores a late local result", async () => {
  const outbound: Array<Record<string, unknown>> = [];
  const stored: Array<Record<string, unknown>> = [];
  const store = {
    append: async (event: Record<string, unknown>) => {
      stored.push(event);
    }
  } as unknown as RuntimeStore;
  const broker = new ClientToolBroker(async (message) => {
    outbound.push(message as unknown as Record<string, unknown>);
  }, store, 10_000);
  const bridge = new ToolBridge(broker, new ServerToolExecutor());
  const pending = bridge.execute({
    runId: "run_cancel",
    toolCallId: "call_pending",
    name: "file_read",
    arguments: { path: "pending.txt" },
    clientTools: ["file_read"],
    state
  });

  for (let attempt = 0; attempt < 20 && !outbound.some((message) => message.type === "tool_call.request"); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(outbound.some((message) => message.type === "tool_call.request"));
  assert.equal(await broker.cancelRun("run_cancel", "parent cancelled"), 1);
  await assert.rejects(pending, /parent cancelled/);
  assert.equal(await broker.handleResult({
    type: "tool_call.result",
    run_id: "run_cancel",
    tool_call_id: "call_pending",
    status: "ok",
    result: { content: "late" }
  }), false);
  assert.equal(stored.filter((event) => event.type === "tool.call" && event.status === "cancelled").length, 1);
  assert.equal(outbound.filter((message) => message.type === "tool_call.delta" && message.status === "cancelled").length, 1);
});
