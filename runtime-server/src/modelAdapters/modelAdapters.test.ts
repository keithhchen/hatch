import assert from "node:assert/strict";
import test from "node:test";
import { RUNTIME_LLM_PROFILE_NAMES, llmProfile } from "../llmProfiles.js";
import { GeminiAdapter, KimiAdapter, OpenAICompatibleAdapter, adapterFor } from "./index.js";

const toolCallHistory = {
  model: "m",
  messages: [
    { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", content: "kept", tool_calls: [{ id: "t2", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "assistant", content: "" }
  ]
};

test("every profile names a family that resolves to an adapter", () => {
  const expected = { kimi: KimiAdapter, "openai-compatible": OpenAICompatibleAdapter, gemini: GeminiAdapter } as const;
  for (const name of RUNTIME_LLM_PROFILE_NAMES) {
    const profile = llmProfile(name);
    const adapter = adapterFor(profile);
    assert.ok(adapter instanceof expected[profile.family], `${name} -> ${profile.family}`);
    const endpoint = adapter.endpoint(profile, { env: {} });
    assert.equal(endpoint.baseUrl, profile.baseUrl);
    assert.equal(adapter.model(profile, endpoint).id, profile.model);
  }
  assert.deepEqual(
    RUNTIME_LLM_PROFILE_NAMES.map((name) => [name, llmProfile(name).family]),
    [
      ["kimi-k2.6", "kimi"],
      ["kimi-k2.6-no-thinking", "kimi"],
      ["deepseek-v4-flash", "openai-compatible"],
      ["gemini-api", "gemini"],
      ["gemini-3.1-pro", "gemini"],
      ["kimi-k3.1-pro", "kimi"],
      ["deepseek-v4-pro", "openai-compatible"]
    ]
  );
});

test("KimiAdapter omits empty tool-call content and applies the profile's thinking type", () => {
  const profile = llmProfile("kimi-k3.1-pro");
  const body = new KimiAdapter().normalizePayload(profile, toolCallHistory) as typeof toolCallHistory & { thinking: unknown };
  assert.equal("content" in body.messages[1]!, false);
  assert.equal(body.messages[2]!.content, "kept");
  assert.equal(body.messages[3]!.content, "");
  assert.deepEqual(body.thinking, { type: "enabled" });
  const disabled = new KimiAdapter().normalizePayload(llmProfile("kimi-k2.6-no-thinking"), toolCallHistory) as { thinking: unknown };
  assert.deepEqual(disabled.thinking, { type: "disabled" });
  // K2.6 leaves thinking to pi-ai's reasoning level.
  assert.equal("thinking" in (new KimiAdapter().normalizePayload(llmProfile("kimi-k2.6"), toolCallHistory) as object), false);
});

test("KimiAdapter only accepts official Moonshot endpoints and honors the profile's endpoint env", () => {
  const adapter = new KimiAdapter();
  assert.throws(() => adapter.endpoint(llmProfile("kimi-k2.6"), { baseUrl: "https://api.openai.com/v1" }), /official Moonshot/);
  assert.deepEqual(
    adapter.endpoint(llmProfile("kimi-k2.6"), { env: { OPENAI_BASE_URL: "https://api.moonshot.ai" } }),
    { baseUrl: "https://api.moonshot.ai/v1", provider: "moonshotai" }
  );
  assert.equal(adapter.endpoint(llmProfile("kimi-k3.1-pro"), { env: { OPENAI_BASE_URL: "https://api.moonshot.ai" } }).baseUrl, "https://api.moonshot.cn/v1");
});

test("OpenAICompatibleAdapter keeps tool-call content and only adds the thinking type", () => {
  const adapter = new OpenAICompatibleAdapter();
  const body = adapter.normalizePayload(llmProfile("deepseek-v4-pro"), toolCallHistory) as typeof toolCallHistory & { thinking: unknown };
  assert.deepEqual(body.messages, toolCallHistory.messages);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(adapter.normalizePayload(llmProfile("deepseek-v4-pro"), "raw"), "raw");
});

test("GeminiAdapter leaves the payload to pi-ai", () => {
  const profile = llmProfile("gemini-3.1-pro");
  assert.equal(new GeminiAdapter().normalizePayload(profile, toolCallHistory), toolCallHistory);
  assert.equal(new GeminiAdapter().model(profile, { baseUrl: profile.baseUrl, provider: profile.provider }).api, "google-generative-ai");
});

test("adapters refuse to turn off thinking when the profile requires it", () => {
  assert.throws(
    () => adapterFor(llmProfile("kimi-k2.6")).resolve(llmProfile("kimi-k2.6"), { apiKey: "k", thinkingLevel: "off" as never }),
    /Thinking must be enabled/
  );
});
