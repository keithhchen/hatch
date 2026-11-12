import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROLES } from "./modelRoles.js";

test("model roles keep today's choices", () => {
  assert.deepEqual({ ...MODEL_ROLES }, { assistant: "kimi-k3.1-pro", worker: "kimi-k2.6", factory: "kimi-k2.6", ingest: "kimi-k3.1-pro" });
});
