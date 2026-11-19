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
      ["kimi-k3.1-pro-highspeed", "kimi"],
      ["deepseek-v4-pro", "openai-compatible"],
      ["deepseek-flash", "openai-compatible"],
      ["deepseek-flash-thinking", "openai-compatible"],
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

test("a Gemini call named <prefix>:<declared tool> is the declared tool; other names are left alone", async () => {
  const { withToolNameRepair } = await import("./finish.js");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
  const block = (name: string) => ({ type: "toolCall", id: "1", name, arguments: {} });
  const inner = (() => {
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: "done", reason: "toolUse", message: { content: [block("default_grep_fallback:creator_grep"), block("nope:unknown"), block("creator_read")] } } as never);
      s.end();
    });
    return s;
  }) as never;
  const out = withToolNameRepair(inner)({} as never, { tools: [{ name: "creator_grep" }, { name: "creator_read" }] } as never, {} as never) as AsyncIterable<{ message?: { content: Array<{ name: string }> } }>;
  const names: string[] = [];
  for await (const event of out) names.push(...(event.message?.content ?? []).map((b) => b.name));
  assert.deepEqual(names, ["creator_grep", "nope:unknown", "creator_read"]);
});

test("deepseek-flash-thinking sends thinking enabled with reasoning_effort; deepseek-flash stays disabled", () => {
  const adapter = new OpenAICompatibleAdapter();
  const on = adapter.normalizePayload(llmProfile("deepseek-flash-thinking"), { model: "deepseek-flash", messages: [] }) as Record<string, unknown>;
  assert.deepEqual(on.thinking, { type: "enabled" });
  assert.equal(on.reasoning_effort, "low");
  const off = adapter.normalizePayload(llmProfile("deepseek-flash"), { model: "deepseek-flash", messages: [] }) as Record<string, unknown>;
  assert.deepEqual(off.thinking, { type: "disabled" });
  assert.equal("reasoning_effort" in off, false);
});

const sse = (...chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ id: "c", object: "chat.completion.chunk", model: "deepseek-flash", choices: [{ index: 0, delta: d, finish_reason: finish }] });

test("deepseek-flash-thinking: reasoning_content streams as thinking and is sent back on every assistant message, earlier turns included", async () => {
  const profile = llmProfile("deepseek-flash-thinking");
  const adapter = adapterFor(profile);
  const bodies: Array<Record<string, any>> = [];
  const replies = [
    sse(
      delta({ role: "assistant", reasoning_content: "I should " }),
      delta({ reasoning_content: "read the page." }),
      delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: "{\"u\":1}" } }] }),
      delta({}, "tool_calls")
    )
  ];
  const fetchFn = (async (_url: unknown, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return replies.shift() ?? sse(delta({ role: "assistant", content: "done" }), delta({}, "stop")); }) as typeof fetch;
  const resolved = adapter.resolve(profile, { apiKey: "k", fetch: fetchFn });
  const model = adapter.model(profile, adapter.endpoint(profile, {}));
  const stream = adapter.streamFn(profile, resolved);
  const tools = [{ name: "read", description: "r", parameters: { type: "object", properties: { u: { type: "number" } } } }];
  const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });

  const first = await stream(model as never, { messages: [user("audit")], tools } as never, {} as never);
  const events: string[] = [];
  for await (const e of first as AsyncIterable<{ type: string }>) events.push(e.type);
  const message = await (first as { result(): Promise<any> }).result();
  assert.ok(events.includes("thinking_delta") && events.includes("thinking_end"));
  assert.equal(message.content[0].type, "thinking");
  assert.equal(message.content[0].thinking, "I should read the page.");
  assert.deepEqual(bodies[0]!.thinking, { type: "enabled" });
  assert.equal(bodies[0]!.reasoning_effort, "low");

  const done = { role: "assistant", content: [{ type: "thinking", thinking: "wrap up", thinkingSignature: "reasoning_content" }, { type: "text", text: "ok" }], api: "openai-completions", provider: "deepseek", model: "deepseek-flash", usage: message.usage, stopReason: "stop", timestamp: 3 };
  const toolResult = { role: "toolResult", toolCallId: "call_1", toolName: "read", content: [{ type: "text", text: "page" }], isError: false, timestamp: 2 };
  const second = await stream(model as never, { messages: [user("audit"), message, toolResult, done, user("again")], tools } as never, {} as never);
  for await (const _ of second as AsyncIterable<unknown>) { /* drain */ }
  const sent = bodies[1]!.messages.filter((m: any) => m.role === "assistant");
  assert.equal(sent[0].reasoning_content, "I should read the page.");
  assert.equal(sent[0].tool_calls[0].id, "call_1");
  assert.equal(sent[1].reasoning_content, "wrap up");
});
