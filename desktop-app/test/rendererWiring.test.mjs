import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { selectWorkspace } from "../src/renderer/workspaceState.js";

const source = await readFile(new URL("../src/renderer/main.jsx", import.meta.url), "utf8");

test("tool request wiring declares and initializes the workspace ref", () => {
  const declaration = "const workspaceRef = useRef(\"\");";
  const declarationIndex = source.indexOf(declaration);
  assert.notEqual(declarationIndex, -1);
  assert.match(source, /workspaceRef\.current = savedWorkspace;/);
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
    }
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
