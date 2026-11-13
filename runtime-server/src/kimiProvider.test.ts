import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODEL,
  KIMI_TEMPERATURE,
  kimiModelRuntimeRecord,
  requireKimiProviderConfig
} from "./kimiProvider.js";

test("Kimi-only provider defaults every runtime role to the Kimi K3.1 profile", () => {
  assert.deepEqual(requireKimiProviderConfig({ LLM_API_KEY: "test-key" }), {
    apiKey: "test-key",
    baseURL: KIMI_DEFAULT_BASE_URL,
    model: KIMI_MODEL,
    temperature: KIMI_TEMPERATURE
  });
  assert.deepEqual(kimiModelRuntimeRecord(), {
    provider: "moonshot",
    creator_model: "kimi-k3.1-pro",
    reviewer_model: "kimi-k3.1-pro",
    compaction_model: "kimi-k3.1-pro",
    temperature: 1
  });
});

test("Kimi-only provider has no OpenAI-key fallback and only official endpoints", () => {
  assert.equal(requireKimiProviderConfig({ LLM_API_KEY: "test-key", OPENAI_BASE_URL: "https://api.moonshot.cn/v1/" }).baseURL, "https://api.moonshot.cn/v1");
  assert.throws(
    () => requireKimiProviderConfig({ OPENAI_API_KEY: "not-used" }),
    /Missing LLM_API_KEY/
  );
  assert.throws(
    () => requireKimiProviderConfig({ LLM_API_KEY: "test-key", OPENAI_BASE_URL: "https://example.com/v1" }),
    /official Moonshot endpoint/
  );
});
