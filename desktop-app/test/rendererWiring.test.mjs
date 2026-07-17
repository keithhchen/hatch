import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
