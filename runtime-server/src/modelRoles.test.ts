import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_ROLES, modelRole } from "./modelRoles.js";

test("model roles keep today's choices", () => {
  assert.deepEqual({ ...MODEL_ROLES }, { assistant: "kimi-k3.1-pro", worker: "kimi-k2.6", factory: "kimi-k2.6", ingest: "kimi-k3.1-pro" });
});

test("an overridable role takes its environment override, else the MODEL_ROLES default", () => {
  assert.equal(modelRole("factory", {}), MODEL_ROLES.factory);
  assert.equal(modelRole("factory", { HATCH_FACTORY_LLM_PROFILE: "  " }), MODEL_ROLES.factory, "a blank override is no override");
  assert.equal(modelRole("factory", { HATCH_FACTORY_LLM_PROFILE: " f " }), "f");
  assert.equal(modelRole("ingest", { HATCH_INGEST_MODEL: "i" }), "i");
  assert.equal(modelRole("ingest", { HATCH_LLM_PROFILE: "x" }), MODEL_ROLES.ingest, "another role's variable does not apply");
});

test("the Assistant and worker ignore the compose-wide profile variables", () => {
  const env = { HATCH_LLM_PROFILE: "kimi-k2.6", HATCH_FACTORY_LLM_PROFILE: "gemini-3.1-pro" };
  assert.equal(modelRole("assistant", env), MODEL_ROLES.assistant);
  assert.equal(modelRole("worker", env), MODEL_ROLES.worker);
});
