import assert from "node:assert/strict";
import test from "node:test";
import { llmProfile, resolveFactoryLlmProfile, resolveLlmProfile } from "./llmProfiles.js";

test("resolveLlmProfile: an unset or blank profile is an error, never a default", () => {
  assert.throws(() => resolveLlmProfile({}), /HATCH_LLM_PROFILE is not set/);
  assert.throws(() => resolveLlmProfile({ HATCH_LLM_PROFILE: "  " }), /HATCH_LLM_PROFILE is not set/);
});

test("resolveLlmProfile: an unknown profile is an error; a known one resolves", () => {
  assert.throws(() => resolveLlmProfile({ HATCH_LLM_PROFILE: "nope" }), /Unknown Runtime HATCH_LLM_PROFILE: nope/);
  assert.equal(resolveLlmProfile({ HATCH_LLM_PROFILE: "kimi-k3.1-pro" }).name, "kimi-k3.1-pro");
});

test("Kimi is only K3.1: the Factory default, no K2.6 profile, reasoning_effort low and no thinking type", () => {
  assert.equal(resolveFactoryLlmProfile({}).name, "kimi-k3.1-pro");
  assert.throws(() => resolveLlmProfile({ HATCH_LLM_PROFILE: "kimi-k2.6" }), /Unknown Runtime HATCH_LLM_PROFILE/);
  assert.throws(() => resolveFactoryLlmProfile({ HATCH_FACTORY_LLM_PROFILE: "kimi-k2.6" }), /Unknown Factory/);
  const profile = llmProfile("kimi-k3.1-pro");
  assert.equal(profile.reasoningEffort, "low");
  assert.equal(profile.thinkingType, undefined);
});
