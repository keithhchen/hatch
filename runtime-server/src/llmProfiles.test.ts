import assert from "node:assert/strict";
import test from "node:test";
import { GEMINI_4_STALL, LLM_PROFILE_NAMES, llmProfile, requireLlmApiKey } from "./llmProfiles.js";

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
    assert.deepEqual(profile.stall, GEMINI_4_STALL);
  }
});

test("deepseek-flash is the vision-capable DeepSeek profile: images allowed, thinking disabled, same key as the other DeepSeek profiles", () => {
  const profile = llmProfile("deepseek-flash");
  assert.equal(profile.model, "deepseek-flash");
  assert.equal(profile.family, "openai-compatible");
  assert.equal(profile.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(profile.thinkingType, "disabled");
  assert.equal(profile.input, undefined, "text and image");
});

test("deepseek-flash-thinking is deepseek-flash with thinking enabled, high effort, and earlier reasoning replayed", () => {
  const profile = llmProfile("deepseek-flash-thinking");
  assert.equal(profile.model, "deepseek-flash");
  assert.equal(profile.apiKeyEnv, "DEEPSEEK_API_KEY");
  assert.equal(profile.thinkingType, "enabled");
  assert.equal(profile.reasoning, true);
  assert.equal(profile.reasoningEffort, "high");
  assert.equal(profile.replaysEarlierReasoning, true);
  assert.equal(profile.input, undefined, "text and image");
  assert.equal(llmProfile("deepseek-flash").thinkingType, "disabled");
});

test("gemini-3.8-flash is gemini-api by name, and gemini-4-neon has the API's limits; both think at medium with images allowed", () => {
  const flash = llmProfile("gemini-3.8-flash");
  assert.equal(flash.model, llmProfile("gemini-api").model);
  assert.equal(flash.maxTokens, 65_536);
  const neon = llmProfile("gemini-4-neon");
  assert.equal(neon.model, "gemini-4-neon");
  assert.equal(neon.contextWindow, 1_048_576);
  assert.equal(neon.maxTokens, 65_536);
  for (const profile of [flash, neon]) {
    assert.equal(profile.family, "gemini");
    assert.equal(profile.apiKeyEnv, "GEMINI_API_KEY");
    assert.equal(profile.reasoning, true);
    assert.equal(profile.thinkingLevel, "medium");
    assert.equal(profile.input, undefined, "text and image");
    assert.deepEqual(profile.stall, profile.model.startsWith("gemini-4-") ? GEMINI_4_STALL : llmProfile("gemini-3.1-pro").stall);
  }
});
