import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { Agent, type AgentEvent } from "@earendil-works/pi-agent-core";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import type { RunContext } from "./agentRuntime.js";
import { UpstreamError } from "./errors/upstream.js";
import { llmProfile, type LlmProfileName } from "./llmProfiles.js";
import { adapterFor } from "./modelAdapters/index.js";
import { providerFinish } from "./modelAdapters/finish.js";
import { InMemoryModelRoleResolver } from "./modelRoles.js";
import { PiAgentRuntime } from "./piAgentRuntime.js";
import type { ConversationMessage, OutboundMessage, RunStart } from "./protocol.js";
import { withStallGuard } from "./providerStall.js";
import { renderSkillsSection } from "./skills.js";

// Vendor bodies reconstructed from each provider's documented format (see tests/fixtures/providers). Automated tests only.
type Entry = { status: number; contentType?: string; body: string };
const fixture = (name: string): Record<string, Entry> => JSON.parse(readFileSync(new URL(`../tests/fixtures/providers/${name}`, import.meta.url), "utf8"));
const OAI = fixture("mock_oai.json");
const GEMINI = fixture("mock_gemini.json");

const sse = (chunks: unknown[]): Entry => ({ status: 200, body: `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n` });
const oaiChunk = (delta: Record<string, unknown>, finish: string | null = null) => ({ id: "x", object: "chat.completion.chunk", model: "m", choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) });
const oaiText = (text: string, finish = "stop") => sse([oaiChunk({ content: text }), oaiChunk({}, finish)]);
const oaiCall = (args: string, finish: string) => sse([oaiChunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: args } }] }), oaiChunk({}, finish)]);
const geminiBody = (parts: unknown[], finish: string): Entry => ({ status: 200, body: `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, finishReason: finish }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }, responseId: "r" })}\n\n` });

/** Answers the provider's requests with `entries` in order (the last one repeats) and records each request body. */
function provider(t: TestContext, ...entries: Entry[]): Array<Record<string, any>> {
  const requests: Array<Record<string, any>> = [];
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)));
    const entry = entries[Math.min(requests.length - 1, entries.length - 1)]!;
    return new Response(entry.body, { status: entry.status, headers: { "content-type": entry.contentType ?? "text/event-stream" } });
  });
  return requests;
}

const KEYS = { apiKey: "test-key", maxRetries: 0 } as const;
const stream = (name: LlmProfileName) => {
  const profile = llmProfile(name);
  const adapter = adapterFor(profile);
  const config = adapter.resolve(profile, KEYS);
  return { profile, model: adapter.model(profile, config), streamFn: adapter.streamFn(profile, config) };
};
const user = (content: unknown) => ({ role: "user", content, timestamp: 0 });

/** One model call through the adapter, as the Runtime makes it. */
async function ask(name: LlmProfileName, content: unknown = "hi", limits?: Parameters<typeof withStallGuard>[1]): Promise<AssistantMessage> {
  const { model, streamFn } = stream(name);
  const fn = limits ? withStallGuard(streamFn, limits) : streamFn;
  const result = fn(model, { messages: [user(content)] as never }) as { result(): Promise<AssistantMessage> };
  return result.result();
}

const weather = (calls: { n: number }) => ({
  name: "get_weather", label: "get_weather", description: "Weather", parameters: Type.Object({ city: Type.String() }),
  execute: async () => { calls.n++; return { content: [{ type: "text" as const, text: "sunny" }], details: {} }; }
});

/** A full Agent turn through the adapter, with a tool that counts its runs. */
async function agentTurn(name: LlmProfileName): Promise<{ calls: { n: number }; events: AgentEvent[] }> {
  const { profile, model, streamFn } = stream(name);
  void profile;
  const calls = { n: 0 };
  const agent = new Agent({ initialState: { model, tools: [weather(calls)] as never, systemPrompt: "s" }, streamFn, getApiKey: () => "test-key" });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => { events.push(event); });
  await agent.prompt("weather in Paris?");
  return { calls, events };
}

// G4: provider unavailability is classified, and a call that said nothing is asked again

test("G4: Gemini 5xx, Gemini UNAVAILABLE and Moonshot engine_overloaded are transient; a plain rate limit and a bad key are not", () => {
  const kind = (text: string, source = "") => UpstreamError.of(text, source).kind;
  assert.equal(kind(GEMINI.http_503_overloaded!.body, "google gemini-3.8-flash"), "transient");
  assert.equal(kind(GEMINI.http_500!.body, "google gemini-3.8-flash"), "transient");
  assert.equal(kind(`429: ${JSON.stringify(JSON.parse(OAI.moonshot_429_overloaded!.body).error)}`, "moonshot"), "transient");
  assert.equal(kind(`429: ${JSON.stringify(JSON.parse(OAI.moonshot_429_rpm!.body).error)}`, "moonshot"), "rate_limited");
  assert.equal(kind(GEMINI.http_400_bad_key!.body, "google gemini-3.8-flash"), "configuration");
  assert.equal(kind(GEMINI.http_429_quota!.body, "google gemini-3.8-flash"), "quota");
});

test("G4: gemini-api asks again after a 503 and answers; a bad key is not asked again", async (t) => {
  const requests = provider(t, GEMINI.http_503_overloaded!, GEMINI.http_500!, GEMINI.thought_only_then_stop!);
  const stall = llmProfile("gemini-api").stall;
  assert.equal(stall?.restarts, 2);
  const message = await ask("gemini-api", "hi", { ...stall!, backoffMs: 1 });
  assert.equal(requests.length, 3);
  assert.equal(message.stopReason, "stop");

  const bad = provider(t, GEMINI.http_400_bad_key!);
  const failed = await ask("gemini-api", "hi", { ...stall!, backoffMs: 1 });
  assert.equal(bad.length, 1);
  assert.equal(failed.stopReason, "error");
});

test("G4: Moonshot engine_overloaded (429) is asked again, a plain rate limit is not", async (t) => {
  const stall = { ...llmProfile("kimi-k3.1-pro").stall!, backoffMs: 1 };
  const overloaded = provider(t, OAI.moonshot_429_overloaded!, oaiText("ok"));
  assert.equal((await ask("kimi-k3.1-pro", "hi", stall)).stopReason, "stop");
  assert.equal(overloaded.length, 2);
  const limited = provider(t, OAI.moonshot_429_rpm!, oaiText("ok"));
  assert.equal((await ask("kimi-k3.1-pro", "hi", stall)).stopReason, "error");
  assert.equal(limited.length, 1);
});

// G1: a text-only model is told so

test("G1: deepseek-v4-pro declares text input and its request carries the omitted-image placeholder, not the image", async (t) => {
  assert.deepEqual(llmProfile("deepseek-v4-pro").input, ["text"]);
  assert.equal(llmProfile("deepseek-v4-flash").input, undefined);
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const request = (name: LlmProfileName) => ask(name, [{ type: "text", text: "what colour?" }, image]);

  const pro = provider(t, oaiText("ok"));
  await request("deepseek-v4-pro");
  const sent = JSON.stringify(pro[0]!.messages);
  assert.doesNotMatch(sent, /image_url|base64/);
  assert.match(sent, /image omitted: model does not support images/);

  const flash = provider(t, oaiText("ok"));
  await request("deepseek-v4-flash");
  assert.match(JSON.stringify(flash[0]!.messages), /image_url/);
});

// G2: a provider safety stop is an ending, not an outage

test("G2: content_filter and SAFETY/RECITATION are told as a content filter; other provider errors are not", async (t) => {
  provider(t, OAI.content_filter!);
  for (const name of ["kimi-k3.1-pro", "deepseek-v4-flash"] as const) assert.equal(providerFinish(await ask(name)), "content_filter");
  for (const entry of [GEMINI.safety!, GEMINI.recitation!]) {
    provider(t, entry);
    assert.equal(providerFinish(await ask("gemini-api")), "content_filter");
  }
  provider(t, GEMINI.malformed_function_call!);
  const malformed = await ask("gemini-api");
  assert.equal(malformed.stopReason, "error");
  assert.equal(providerFinish(malformed), undefined);
});

const input = { type: "client.message", run_id: "run_norm", conversation_id: "conv_norm", message: { role: "user", content: "hi" } } as RunStart;
const toolDefinitions = [{ type: "function" as const, function: { name: "get_weather", description: "Weather", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];

/** A Run on the Kimi profile against canned provider bodies; what it emitted and what it persisted for the model. */
async function run(t: TestContext, ...entries: Entry[]): Promise<{ events: OutboundMessage[]; persisted: ConversationMessage[]; requests: Array<Record<string, any>>; failure?: Error }> {
  const saved = { key: process.env.LLM_API_KEY };
  process.env.LLM_API_KEY = "test-key";
  t.after(() => {
    for (const [name, value] of [["LLM_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const requests = provider(t, ...entries);
  const persisted: ConversationMessage[] = [];
  const events: OutboundMessage[] = [];
  const context = {
    state: { status: "running" }, messages: [input.message], clientTools: [],
    sessionSkills: { records: [], visibleRecords: [], rendered: renderSkillsSection([]) },
    persistModelMessage: async (message: ConversationMessage) => { persisted.push(message); }
  } as unknown as RunContext;
  let failure: Error | undefined;
  try {
    for await (const event of new PiAgentRuntime({ models: new InMemoryModelRoleResolver(), toolDefinitions, env: process.env, stall: { firstEventMs: 5_000, silenceMs: 5_000 } }).run(input, context)) events.push(event);
  } catch (error) { failure = error as Error; }
  return { events, persisted, requests, failure };
}
const completed = (events: OutboundMessage[]) => events.find((event) => event.type === "turn.completed") as { finish_reason: string } | undefined;
const textOf = (events: OutboundMessage[]) => events.flatMap((event) => event.type === "assistant.delta" && event.delta.kind === "text" ? [event.delta.content] : []).join("");

test("G2: a provider safety stop completes the Run as content_filter instead of failing it", async (t) => {
  const { events, failure } = await run(t, OAI.content_filter!);
  assert.equal(failure, undefined);
  assert.equal(completed(events)?.finish_reason, "content_filter");
});

// G3: the output limit is its own ending

test("G3: a reply cut at the output limit completes as length and keeps its text", async (t) => {
  const { events, failure } = await run(t, oaiText("The first half of", "length"));
  assert.equal(failure, undefined);
  assert.equal(completed(events)?.finish_reason, "length");
  assert.equal(textOf(events), "The first half of");
});

test("G3: a model that spends its whole budget thinking completes as length with a note, not a generic failure", async (t) => {
  const { events, failure } = await run(t, sse([oaiChunk({ reasoning_content: "hmm" }), oaiChunk({}, "length")]));
  assert.equal(failure, undefined);
  assert.equal(completed(events)?.finish_reason, "length");
  assert.match(textOf(events), /cut off/);
});

// G8: only a turn whose tool calls will be answered is replayed with them

test("G8: an errored turn that holds a tool call is not persisted as a tool turn", async (t) => {
  const partial = sse([oaiChunk({ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" } }] }), oaiChunk({}, "content_filter")]);
  const { events, persisted } = await run(t, partial);
  assert.equal(completed(events)?.finish_reason, "content_filter");
  assert.deepEqual(persisted.filter((message) => message.tool_calls?.length), []);
  const dropped = await run(t, { status: 200, body: OAI.midstream_error_object!.body.replace("Partial", "") });
  assert.deepEqual(dropped.persisted.filter((message) => message.tool_calls?.length), []);
});

// G6: a truncated tool call is never executed

test("G6: Chat Completions tool-call arguments that are not complete JSON mark the call invalid; it does not run", async (t) => {
  provider(t, OAI.invalid_tool_args!);
  const message = await ask("kimi-k3.1-pro");
  assert.equal(message.stopReason, "length");

  const requests = provider(t, OAI.invalid_tool_args!, oaiText("Sorry, let me retry."));
  const { calls, events } = await agentTurn("kimi-k3.1-pro");
  assert.equal(calls.n, 0);
  assert.equal(requests.length, 2);
  const results = events.filter((event) => event.type === "tool_execution_end") as Array<{ isError: boolean }>;
  assert.deepEqual(results.map((result) => result.isError), [true]);

  provider(t, oaiCall("{\"city\":\"Paris\"}", "tool_calls"), oaiText("Sunny."));
  assert.equal((await agentTurn("kimi-k3.1-pro")).calls.n, 1);
});

test("G6: Creator Factory keeps the raw arguments for its own submission gate", async (t) => {
  const { factoryAdapterFor } = await import("./modelAdapters/factory.js");
  const profile = llmProfile("kimi-k3.1-pro");
  const adapter = factoryAdapterFor(profile);
  const config = adapter.resolve(profile, KEYS);
  provider(t, OAI.invalid_tool_args!);
  const result = adapter.streamFn(profile, config)(adapter.model(profile, config), { messages: [user("hi")] as never }) as { result(): Promise<AssistantMessage> };
  assert.equal((await result.result()).stopReason, "toolUse");
});

test("G6: a cut tool call is answered as an error, so the persisted turn is replayed with its result", async (t) => {
  const { events, persisted } = await run(t, OAI.invalid_tool_args!, oaiText("Retrying later."));
  assert.equal(completed(events)?.finish_reason, "stop");
  assert.equal(persisted.filter((message) => message.tool_calls?.length).length, 1);
  assert.equal(persisted.filter((message) => message.role === "tool").length, 1);
});

// G7: a Gemini function call is not run when the reply was stopped or cut

test("G7: Gemini SAFETY or MAX_TOKENS after a function call does not run the tool", async (t) => {
  provider(t, GEMINI.safety_after_function_call!, geminiBody([{ text: "done" }], "STOP"));
  const safety = await agentTurn("gemini-api");
  assert.equal(safety.calls.n, 0);
  const last = safety.events.at(-1) as { messages: AssistantMessage[] };
  assert.equal(providerFinish(last.messages.at(-1)!), "content_filter");

  provider(t, GEMINI.max_tokens_after_function_call!, geminiBody([{ text: "done" }], "STOP"));
  const cut = await agentTurn("gemini-api");
  assert.equal(cut.calls.n, 0);
  assert.deepEqual((cut.events.filter((event) => event.type === "tool_execution_end") as Array<{ isError: boolean }>).map((result) => result.isError), [true]);
});

test("G7: a Gemini function call that stopped normally still runs", async (t) => {
  provider(t, geminiBody([{ functionCall: { name: "get_weather", args: { city: "Paris" } }, thoughtSignature: "c2ln" }], "STOP"), geminiBody([{ text: "Sunny." }], "STOP"));
  assert.equal((await agentTurn("gemini-api")).calls.n, 1);
});
