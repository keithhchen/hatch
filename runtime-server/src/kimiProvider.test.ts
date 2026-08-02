import assert from "node:assert/strict";
import { test } from "node:test";
import {
  KIMI_DEFAULT_BASE_URL,
  KIMI_MODEL,
  KIMI_TEMPERATURE,
  KIMI_THINKING,
  kimiModelRuntimeRecord,
  requireKimiProviderConfig
} from "./kimiProvider.js";

test("Kimi-only provider defaults every runtime role to the non-thinking Kimi K2.6 profile", () => {
  assert.deepEqual(requireKimiProviderConfig({ MOONSHOT_API_KEY: "test-key" }), {
    apiKey: "test-key",
    baseURL: KIMI_DEFAULT_BASE_URL,
    model: KIMI_MODEL,
    temperature: KIMI_TEMPERATURE,
    thinking: KIMI_THINKING
  });
  assert.deepEqual(kimiModelRuntimeRecord(), {
    provider: "moonshot",
    creator_model: "kimi-k2.6",
    reviewer_model: "kimi-k2.6",
    compaction_model: "kimi-k2.6",
    temperature: 1,
    thinking_mode: "disabled"
  });
});

test("Kimi-only provider accepts exact explicit role models", () => {
  const config = requireKimiProviderConfig({
    MOONSHOT_API_KEY: "test-key",
    OPENAI_BASE_URL: "https://api.moonshot.cn/v1/",
    HATCH_CREATOR_MODEL: "kimi-k2.6",
    HATCH_REVIEWER_MODEL: "kimi-k2.6",
    HATCH_COMPACTION_MODEL: "kimi-k2.6"
  });
  assert.equal(config.model, "kimi-k2.6");
  assert.equal(config.baseURL, "https://api.moonshot.cn/v1");
});

test("Kimi-only provider has no OpenAI-key or alternate-model fallback", () => {
  assert.throws(
    () => requireKimiProviderConfig({ OPENAI_API_KEY: "not-used" }),
    /Missing MOONSHOT_API_KEY/
  );
  for (const name of ["HATCH_CREATOR_MODEL", "HATCH_REVIEWER_MODEL", "HATCH_COMPACTION_MODEL"]) {
    assert.throws(
      () => requireKimiProviderConfig({ MOONSHOT_API_KEY: "test-key", [name]: "other-model" }),
      new RegExp(`${name} must be kimi-k2\\.6`)
    );
  }
  assert.throws(
    () => requireKimiProviderConfig({ MOONSHOT_API_KEY: "test-key", OPENAI_BASE_URL: "https://example.com/v1" }),
    /official Moonshot endpoint/
  );
});
