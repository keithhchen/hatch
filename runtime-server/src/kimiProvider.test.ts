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

test("Kimi-only provider accepts exact explicit role models", () => {
  const config = requireKimiProviderConfig({
    LLM_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.moonshot.cn/v1/",
    HATCH_CREATOR_MODEL: "kimi-k3.1-pro",
    HATCH_REVIEWER_MODEL: "kimi-k3.1-pro",
    HATCH_COMPACTION_MODEL: "kimi-k3.1-pro"
  });
  assert.equal(config.model, "kimi-k3.1-pro");
  assert.equal(config.baseURL, "https://api.moonshot.cn/v1");
});

test("Kimi-only provider has no OpenAI-key or alternate-model fallback", () => {
  assert.throws(
    () => requireKimiProviderConfig({ OPENAI_API_KEY: "not-used" }),
    /Missing LLM_API_KEY/
  );
  for (const name of ["HATCH_CREATOR_MODEL", "HATCH_REVIEWER_MODEL", "HATCH_COMPACTION_MODEL"]) {
    assert.throws(
      () => requireKimiProviderConfig({ LLM_API_KEY: "test-key", [name]: "other-model" }),
      new RegExp(`${name} must be kimi-k3\\.1-pro`)
    );
  }
  assert.throws(
    () => requireKimiProviderConfig({ LLM_API_KEY: "test-key", OPENAI_BASE_URL: "https://example.com/v1" }),
    /official Moonshot endpoint/
  );
});
