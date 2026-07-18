import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createSocketLifecycleState,
  handleCurrentSocketClose,
  registerSocket
} from "../src/renderer/socketLifecycle.js";
import {
  invokeWorkspaceCommand,
  restoreWorkspace,
  selectWorkspace
} from "../src/renderer/workspaceState.js";

const source = await readFile(new URL("../src/renderer/main.jsx", import.meta.url), "utf8");

test("tool request wiring declares and initializes the workspace ref", () => {
  const declaration = "const workspaceRef = useRef(\"\");";
  const declarationIndex = source.indexOf(declaration);
  assert.notEqual(declarationIndex, -1);
  assert.match(source, /restoreWorkspace\(\{/);
  assert.match(source, /workspaceRef\.current = value;/);
  assert.match(source, /workspaceRef\.current = normalizedWorkspace;/);
  assert.match(source, /workspaceRoot: workspaceRef\.current \|\| workspace/);
  assert.ok(declarationIndex < source.indexOf("workspaceRef.current || workspace"));
});

test("tool_call.request uses the local bridge handler after activity recording", () => {
  const requestBranch = source.slice(source.indexOf('message.type === "tool_call.request"'));
  assert.match(requestBranch, /recordRendererTrace\("tool_request\.received"/);
  assert.match(requestBranch, /upsertToolEvent\(/);
  assert.match(requestBranch, /await handleLocalToolRequest\(message/);
  assert.doesNotMatch(requestBranch, /await handleToolRequest\(message/);
});

test("picker transition executes normalized workspace state updates in order", async () => {
  const calls = [];
  const traces = [];
  const storage = {
    setItem(key, value) {
      calls.push(["storage", key, value]);
    }
  };
  let workspaceRef = "/";
  let workspaceState = "/";
  let disconnected = false;
  const normalized = "/Users/keithchen/Documents/Hatch HTTP UI Acceptance 20260718";

  const result = await selectWorkspace({
    invokeTauri: async (command, args) => {
      calls.push([command, args]);
      if (command === "pick_workspace") return "/selected/by/picker";
      return normalized;
    },
    storage,
    setWorkspaceRef: (value) => {
      calls.push(["ref", value]);
      workspaceRef = value;
    },
    setWorkspace: (value) => {
      calls.push(["state", value]);
      workspaceState = value;
    },
    disconnectRuntime: () => {
      calls.push(["disconnect"]);
      disconnected = true;
    },
    previousWorkspace: "/",
    correlationId: "workspace-test-success",
    recordTrace: (...event) => traces.push(event)
  });

  assert.equal(result, normalized);
  assert.equal(workspaceRef, normalized);
  assert.equal(workspaceState, normalized);
  assert.equal(disconnected, true);
  assert.deepEqual(calls.map(([phase]) => phase), [
    "pick_workspace",
    "ensure_workspace",
    "ref",
    "storage",
    "state",
    "disconnect"
  ]);
  assert.equal(calls[1][1].workspaceRoot, "/selected/by/picker");
  assert.deepEqual(calls[3], ["storage", "hatch.workspaceRoot", normalized]);
  assert.deepEqual(traces.map(([phase]) => phase), [
    "workspace.select.start",
    "workspace.pick.start",
    "workspace.pick.invoke.start",
    "workspace.pick.invoke.result",
    "workspace.pick.result",
    "workspace.ensure.start",
    "workspace.ensure.invoke.start",
    "workspace.ensure.invoke.result",
    "workspace.ensure.result",
    "workspace.ref.updated",
    "workspace.storage.write",
    "workspace.state.updated",
    "workspace.disconnect"
  ]);
  assert.deepEqual(traces[4][3], { root_changed: true, equals_previous: false });
  assert.deepEqual(traces[10][3], { root_changed: true, equals_previous: false });
});

test("picker cancellation leaves workspace state untouched", async () => {
  const traces = [];
  let mutations = 0;
  const result = await selectWorkspace({
    invokeTauri: async () => undefined,
    storage: { setItem: () => { mutations += 1; } },
    setWorkspaceRef: () => { mutations += 1; },
    setWorkspace: () => { mutations += 1; },
    disconnectRuntime: () => { mutations += 1; },
    correlationId: "workspace-test-cancel",
    recordTrace: (...event) => traces.push(event)
  });

  assert.equal(result, undefined);
  assert.equal(mutations, 0);
  assert.deepEqual(traces.map(([phase, status]) => [phase, status]), [
    ["workspace.select.start", "requested"],
    ["workspace.pick.start", "requested"],
    ["workspace.pick.invoke.start", "requested"],
    ["workspace.pick.invoke.result", "resolved"],
    ["workspace.pick.result", "cancelled"]
  ]);
});

test("ensure failure is observable and does not persist a workspace", async () => {
  const traces = [];
  let mutations = 0;
  await assert.rejects(
    selectWorkspace({
      invokeTauri: async (command) => {
        if (command === "pick_workspace") return "/selected/by/picker";
        throw new Error("ensure failed");
      },
      storage: { setItem: () => { mutations += 1; } },
      setWorkspaceRef: () => { mutations += 1; },
      setWorkspace: () => { mutations += 1; },
      disconnectRuntime: () => { mutations += 1; },
      correlationId: "workspace-test-error",
      recordTrace: (...event) => traces.push(event)
    }),
    /ensure failed/
  );

  assert.equal(mutations, 0);
  assert.deepEqual(traces.map(([phase]) => phase), [
    "workspace.select.start",
    "workspace.pick.start",
    "workspace.pick.invoke.start",
    "workspace.pick.invoke.result",
    "workspace.pick.result",
    "workspace.ensure.start",
    "workspace.ensure.invoke.start",
    "workspace.ensure.invoke.error",
    "workspace.select.exception"
  ]);
  assert.deepEqual(traces.at(-1), [
    "workspace.select.exception",
    "error",
    "workspace-test-error",
    {}
  ]);
});

test("initialization restores the persisted picker root instead of the default", async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  const normalized = "/selected/by/picker";
  await selectWorkspace({
    invokeTauri: async () => normalized,
    storage,
    setWorkspaceRef: () => {},
    setWorkspace: () => {}
  });

  let restoredRef = "";
  let restoredState = "";
  const restored = restoreWorkspace({
    storage,
    defaultWorkspace: "/",
    setWorkspaceRef: (value) => { restoredRef = value; },
    setWorkspace: (value) => { restoredState = value; }
  });
  assert.equal(restored, normalized);
  assert.equal(restoredRef, normalized);
  assert.equal(restoredState, normalized);
});

test("workspace command timeout is controlled and observable", async () => {
  const traces = [];
  await assert.rejects(
    invokeWorkspaceCommand({
      invokeTauri: () => new Promise(() => {}),
      command: "pick_workspace",
      timeoutMs: 5,
      onStart: () => traces.push("start"),
      onResolve: () => traces.push("resolve"),
      onReject: (error) => traces.push(error.code)
    }),
    (error) => error.code === "workspace_command_timeout"
  );
  assert.deepEqual(traces, ["start", "workspace_command_timeout"]);
});

test("chooseWorkspace wiring keeps ref assignment before persistence and disconnect", () => {
  const start = source.indexOf("async function chooseWorkspace()");
  const end = source.indexOf("\n  async function connectRuntime", start);
  const body = source.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.ok(body.indexOf("invokeTauri") < body.indexOf("setWorkspaceRef"));
  assert.ok(body.indexOf("setWorkspaceRef") < body.indexOf("setWorkspace,"));
  assert.ok(body.indexOf("setWorkspace,") < body.indexOf("disconnectRuntime:"));
});

test("stale socket close cannot clear the replacement or schedule reconnect", () => {
  const lifecycle = createSocketLifecycleState();
  const oldSocket = {};
  const newSocket = {};
  const normalized = "/selected/by/picker";
  let socketRef = oldSocket;
  let workspaceRoot = normalized;
  let persistedRoot = normalized;
  let reconnects = 0;

  const oldGeneration = registerSocket(lifecycle, oldSocket);
  const newGeneration = registerSocket(lifecycle, newSocket);
  socketRef = newSocket;

  const handled = handleCurrentSocketClose(lifecycle, oldSocket, oldGeneration, () => {
    socketRef = null;
    workspaceRoot = "/";
    persistedRoot = "/";
    reconnects += 1;
  });

  assert.equal(handled, false);
  assert.equal(lifecycle.socket, newSocket);
  assert.equal(socketRef, newSocket);
  assert.equal(workspaceRoot, normalized);
  assert.equal(persistedRoot, normalized);
  assert.equal(reconnects, 0);
  assert.equal(handleCurrentSocketClose(lifecycle, newSocket, newGeneration, () => {}), true);
});

test("socket wiring guards stale lifecycle events and persists only after ensure", () => {
  assert.match(source, /registerSocket\(socketLifecycleRef\.current, socket\)/);
  assert.match(source, /if \(!isCurrentSocket\(socketLifecycleRef\.current, socket, generation\)\) return;/);
  assert.match(source, /handleCurrentSocketClose\(socketLifecycleRef\.current, socket, generation/);
  const connectStart = source.indexOf("async function connectRuntime");
  const socketStart = source.indexOf("const socket = new WebSocket", connectStart);
  const connectBody = source.slice(connectStart, socketStart);
  assert.ok(connectBody.indexOf('await invokeTauri("ensure_workspace"') < connectBody.indexOf('localStorage.setItem("hatch.workspaceRoot", normalizedWorkspace)'));
  assert.ok(connectBody.indexOf('localStorage.setItem("hatch.workspaceRoot", normalizedWorkspace)') < connectBody.indexOf("setWorkspace(normalizedWorkspace)"));
  assert.match(source, /invoke\("record_workspace_trace"/);
});
