import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROLES, modelRole } from "./modelRoles.js";

test("model roles keep today's choices", () => {
  assert.deepEqual({ ...MODEL_ROLES }, { assistant: "kimi-k3.1-pro", worker: "kimi-k2.6", factory: "kimi-k2.6", ingest: "kimi-k3.1-pro" });
});

test("a role is its environment override when one is set, else the MODEL_ROLES default", () => {
  assert.equal(modelRole("assistant", {}), MODEL_ROLES.assistant);
  assert.equal(modelRole("assistant", { HATCH_LLM_PROFILE: "  " }), MODEL_ROLES.assistant, "a blank override is no override");
  assert.equal(modelRole("assistant", { HATCH_LLM_PROFILE: " other " }), "other");
  assert.equal(modelRole("worker", { HATCH_FACTORY_LLM_PROFILE: "w" }), "w");
  assert.equal(modelRole("factory", { HATCH_FACTORY_LLM_PROFILE: "f" }), "f");
  assert.equal(modelRole("ingest", { HATCH_INGEST_MODEL: "i" }), "i");
  assert.equal(modelRole("ingest", { HATCH_LLM_PROFILE: "x" }), MODEL_ROLES.ingest, "another role's variable does not apply");
});
