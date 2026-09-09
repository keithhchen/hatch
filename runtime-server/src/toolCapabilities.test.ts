import assert from "node:assert/strict";
import test from "node:test";
import { requireModelTool, requireTool } from "./tools.js";

test("file_read advertises its implemented image and managed-attachment capability", () => {
  const local = requireTool("file_read");
  const model = requireModelTool("file_read");
  assert.match(local.description, /image/);
  assert.match(model.description, /actual image content/);
  assert.match(model.description, /PDF and Office.*Skill/);
  const path = model.properties.path;
  assert.ok(path && typeof path === "object" && "description" in path);
  assert.match(String(path.description), /saved attachment path/);
  assert.equal(model.locality, "hybrid");
  assert.deepEqual(local.schema.parse({ path: "/managed/attachments/photo.png" }), {
    path: "/managed/attachments/photo.png"
  });
});
