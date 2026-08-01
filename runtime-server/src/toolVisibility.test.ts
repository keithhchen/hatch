import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToolArgumentsForVisibility, projectToolResultForVisibility } from "./toolVisibility.js";

test("protected tool results are redacted for visible history while main results remain intact", () => {
  const privateResult = { path: "notes.txt", content: "PRIVATE_LOCAL_CONTENT" };
  assert.deepEqual(projectToolResultForVisibility("skill_run", "fs.read", privateResult), {
    redacted: true,
    reason: "protected_skill_tool_result",
    tool: "fs.read"
  });
  assert.equal(projectToolResultForVisibility("main", "fs.read", privateResult), privateResult);
  assert.deepEqual(projectToolArgumentsForVisibility("skill_run", "fs.write", { content: "PRIVATE_LOCAL_CONTENT" }), {
    redacted: true,
    reason: "protected_skill_tool_arguments",
    tool: "fs.write"
  });
  assert.deepEqual(projectToolArgumentsForVisibility("main", "fs.write", { content: "PRIVATE_LOCAL_CONTENT" }), {
    content: "PRIVATE_LOCAL_CONTENT"
  });
});
