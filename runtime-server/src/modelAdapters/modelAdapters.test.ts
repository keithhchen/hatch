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
      ["deepseek-v4-flash", "openai-compatible"],
      ["gemini-api", "gemini"],
      ["gemini-3.1-pro", "gemini"],
      ["kimi-k3.1-pro", "kimi"],
      ["deepseek-v4-pro", "openai-compatible"],
      ["gemini-4-argon", "gemini"],
      ["gemini-4-carbon", "gemini"],
      ["gemini-4-hydrogen", "gemini"]
    ]
  );
});

test("KimiAdapter omits empty tool-call content and sends reasoning_effort without a thinking field", () => {
  const profile = llmProfile("kimi-k3.1-pro");
  const body = new KimiAdapter().normalizePayload(profile, { ...toolCallHistory, thinking: { type: "enabled" } }) as typeof toolCallHistory & Record<string, unknown>;
  assert.equal("content" in body.messages[1]!, false);
  assert.equal(body.messages[2]!.content, "kept");
  assert.equal(body.messages[3]!.content, "");
  assert.equal("thinking" in body, false);
  assert.equal(body.reasoning_effort, "low");
});

test("KimiAdapter only accepts official Moonshot endpoints and honors the profile's endpoint env", () => {
  const adapter = new KimiAdapter();
  assert.throws(() => adapter.endpoint(llmProfile("kimi-k3.1-pro"), { baseUrl: "https://api.openai.com/v1" }), /official Moonshot/);
  assert.deepEqual(
    adapter.endpoint(llmProfile("kimi-k3.1-pro"), { env: { OPENAI_BASE_URL: "https://api.moonshot.ai" } }),
    { baseUrl: "https://api.moonshot.ai/v1", provider: "moonshotai" }
  );
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

test("Factory adapters are chosen by the profile's family and own the tool-call requirement", async () => {
  const { factoryAdapterFor } = await import("./factory.js");
  const body = { model: "m", tool_choice: "auto" };
  const flash = llmProfile("deepseek-v4-flash");
  const k3 = llmProfile("kimi-k3.1-pro");
  assert.deepEqual(factoryAdapterFor(flash).requireToolChoice(flash, body), { ...body, tool_choice: "required" });
  assert.equal(factoryAdapterFor(k3).requireToolChoice(k3, body), body);
  assert.equal(factoryAdapterFor(k3).recordedProvider(k3), "moonshot");
});

test("Factory K3.1 request has reasoning_effort low and no thinking field, with Moonshot's rejected knobs removed", async () => {
  const { factoryAdapterFor } = await import("./factory.js");
  const k3 = llmProfile("kimi-k3.1-pro");
  const body = factoryAdapterFor(k3).normalizePayload(k3, { model: "m", thinking: { type: "disabled" }, temperature: 0.2, max_tokens: 5, messages: [] }) as Record<string, unknown>;
  assert.equal("thinking" in body, false);
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.tool_choice, "auto");
  assert.equal("temperature" in body, false);
  assert.equal("max_tokens" in body, false);
});
