import assert from "node:assert/strict";
import test from "node:test";
import { LLM_PROFILE_NAMES, llmProfile, requireLlmApiKey } from "./llmProfiles.js";

test("the catalogue names every usable profile, and each resolves to its own data", () => {
  for (const name of LLM_PROFILE_NAMES) assert.equal(llmProfile(name).name, name);
});

test("a missing API key is a model_profile_invalid error naming the variable", () => {
  const profile = llmProfile("deepseek-v4-flash");
  assert.throws(() => requireLlmApiKey(profile, {}), (error: Error & { code?: string }) => error.code === "model_profile_invalid" && /Missing DEEPSEEK_API_KEY/.test(error.message));
  assert.equal(requireLlmApiKey(profile, { DEEPSEEK_API_KEY: " k " }), "k");
});

test("Kimi is only K3.1: no K2.6 profile, reasoning_effort low and no thinking type", () => {
  assert.ok(!(LLM_PROFILE_NAMES as readonly string[]).includes("kimi-k2.6"));
  const profile = llmProfile("kimi-k3.1-pro");
  assert.equal(profile.reasoningEffort, "low");
  assert.equal(profile.thinkingType, undefined);
});
