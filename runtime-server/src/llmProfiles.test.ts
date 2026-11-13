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

test("Gemini 4 profiles: the API's own limits, thinking low, and valid for the roles that take any Gemini", () => {
  const limits = { "gemini-4-argon": 32_768, "gemini-4-carbon": 32_768, "gemini-4-hydrogen": 65_536 } as const;
  for (const [name, maxTokens] of Object.entries(limits)) {
    const profile = llmProfile(name as keyof typeof limits);
    assert.equal(profile.model, name);
    assert.equal(profile.family, "gemini");
    assert.equal(profile.contextWindow, 1_048_576);
    assert.equal(profile.maxTokens, maxTokens);
    assert.equal(profile.thinkingLevel, "low");
    assert.deepEqual(profile.stall, llmProfile("gemini-3.1-pro").stall);
  }
});
