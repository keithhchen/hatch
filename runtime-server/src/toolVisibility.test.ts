import assert from "node:assert/strict";
import { test } from "node:test";
import { projectToolArgumentsForVisibility, projectToolResultForVisibility } from "./toolVisibility.js";

test("protected tool results are redacted for visible history while main results remain intact", () => {
  const privateResult = { path: "notes.txt", content: "PRIVATE_LOCAL_CONTENT" };
  assert.deepEqual(projectToolResultForVisibility("skill_run", "file_read", privateResult), {
    redacted: true,
    reason: "protected_skill_tool_result",
    tool: "file_read"
  });
  assert.equal(projectToolResultForVisibility("main", "file_read", privateResult), privateResult);
  assert.deepEqual(projectToolArgumentsForVisibility("skill_run", "file_write", { content: "PRIVATE_LOCAL_CONTENT" }), {
    redacted: true,
    reason: "protected_skill_tool_arguments",
    tool: "file_write"
  });
  assert.deepEqual(projectToolArgumentsForVisibility("main", "file_write", { content: "PRIVATE_LOCAL_CONTENT" }), {
    content: "PRIVATE_LOCAL_CONTENT"
  });
});
