import assert from "node:assert/strict";
import test from "node:test";
import { resolveLlmProfile } from "./llmProfiles.js";

test("resolveLlmProfile: an unset or blank profile is an error, never a default", () => {
  assert.throws(() => resolveLlmProfile({}), /HATCH_LLM_PROFILE is not set/);
  assert.throws(() => resolveLlmProfile({ HATCH_LLM_PROFILE: "  " }), /HATCH_LLM_PROFILE is not set/);
});

test("resolveLlmProfile: an unknown profile is an error; a known one resolves", () => {
  assert.throws(() => resolveLlmProfile({ HATCH_LLM_PROFILE: "nope" }), /Unknown Runtime HATCH_LLM_PROFILE: nope/);
  assert.equal(resolveLlmProfile({ HATCH_LLM_PROFILE: "kimi-k2.6" }).name, "kimi-k2.6");
});
