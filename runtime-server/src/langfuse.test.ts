import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before, beforeEach } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, createModels, createProvider, envApiKeyAuth, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { QdrantKnowledgeProvider } from "./agentCorpus.js";
import { TracedTranscriber } from "./assets/adapters.js";
import { TracedStreamingStt } from "./factoryAgents/stt.js";
import { TracedHostedAgent } from "./hostedAgents/kimiHostedAgent.js";
import { flushLangfuseObservability, initializeLangfuseObservability, reportExportFailures, shutdownLangfuseObservability, traceGeneration, traceProviderStream, usageOf } from "./langfuse.js";
import { createKimiModel } from "./piModel.js";
import { summarizeWithPi } from "./piCompaction.js";
import { withStallGuard } from "./providerStall.js";

type Span = { name: string; attributes: Record<string, unknown>; status: { code: number } };
const exported: Span[] = [];
let failExports = false;
const lines: string[] = [];

before(() => {
  initializeLangfuseObservability(
    { LANGFUSE_ENABLED: "true", LANGFUSE_PUBLIC_KEY: "pk-lf-test", LANGFUSE_SECRET_KEY: "sk-lf-test", LANGFUSE_BASE_URL: "https://langfuse.test" },
    { exporter: { export: (spans, done) => { exported.push(...spans as unknown as Span[]); done(failExports ? { code: 1, error: new Error("boom") } : { code: 0 }); }, shutdown: async () => {} } }
  );
});
after(shutdownLangfuseObservability);
beforeEach(() => { exported.length = 0; });

const spansNamed = async (name: string): Promise<Span[]> => { await flushLangfuseObservability(); return exported.filter(span => span.name === name); };
const attr = (span: Span, suffix: string) => Object.entries(span.attributes).find(([key]) => key.endsWith(suffix))?.[1];
const meta = (span: Span, key: string) => attr(span, `metadata.${key}`);

test("traceGeneration records model, provider, usage, output and who it was for", async () => {
  await traceGeneration("probe", { model: "m-1", provider: "p-1", userId: "acct-1", sessionId: "conv-1", requestId: "req-1" }, async () => ({ text: "hi" }), result => ({ output: result.text, usage: { input: 3, output: 2, total: 5 } }));
  const [span] = await spansNamed("probe");
  assert.ok(span);
  assert.equal(attr(span, "model.name"), "m-1");
  assert.equal(meta(span, "provider"), "p-1");
  assert.match(String(attr(span, "usage_details")), /"input":3/);
  assert.equal(span.attributes["user.id"] ?? attr(span, "user.id"), "acct-1");
  assert.equal(span.attributes["session.id"] ?? attr(span, "session.id"), "conv-1");
  assert.equal(meta(span, "request_id"), "req-1");
});

test("a failing call is an ERROR observation and the error still propagates", async () => {
  await assert.rejects(traceGeneration("fails", { model: "m" }, async () => { throw new Error("upstream down"); }), /upstream down/);
  const [span] = await spansNamed("fails");
  assert.equal(attr(span!, "level"), "ERROR");
  assert.equal(attr(span!, "status_message"), "upstream down");
});

test("usageOf reads OpenAI and DashScope token fields", () => {
  assert.deepEqual(usageOf({ prompt_tokens: 4, total_tokens: 4 }), { input: 4, total: 4 });
  assert.deepEqual(usageOf({ input_tokens: 1, output_tokens: 2 }), { input: 1, output: 2 });
  assert.equal(usageOf({}), undefined);
});

test("each transcription is a generation with provider, model and audio length; unavailable is an error", async () => {
  const ok = new TracedTranscriber("gemini", "gemini-x", { transcribe: async () => ({ status: "ok", text: "hello" }) });
  const down = new TracedTranscriber("qwen", "qwen-x", { transcribe: async () => ({ status: "unavailable", reason: "no key" }) });
  await ok.transcribe(Buffer.alloc(64_000));
  await down.transcribe(Buffer.alloc(32_000));
  const spans = await spansNamed("transcribe");
  const gemini = spans.find(span => meta(span, "provider") === "gemini")!;
  assert.equal(attr(gemini, "model.name"), "gemini-x");
  assert.equal(meta(gemini, "audio_seconds"), "2");
  const qwen = spans.find(span => meta(span, "provider") === "qwen")!;
  assert.equal(attr(qwen, "level"), "ERROR");
  assert.equal(attr(qwen, "status_message"), "no key");
});

test("a streaming recognizer session is one generation, closed with the audio it received", async () => {
  const inner = { model: "qwen-asr", start: async () => {}, sendAudio: () => {}, close: () => {} };
  const stt = new TracedStreamingStt("qwen", inner);
  await stt.start();
  stt.sendAudio(Buffer.alloc(64_000));
  stt.close();
  const [span] = await spansNamed("stt.session");
  assert.equal(attr(span!, "model.name"), "qwen-asr");
  assert.equal(meta(span!, "audio_seconds"), "2");
  const failing = new TracedStreamingStt("qwen", { ...inner, start: async () => { throw new Error("handshake"); } });
  await assert.rejects(failing.start(), /handshake/);
  assert.equal(attr((await spansNamed("stt.session"))[1]!, "level"), "ERROR");
});

test("a hosted run is an observation with the provider session id and outcome", async () => {
  const task = { title: "ingest 1 item(s)", prompt: "go", files: [], secrets: [] };
  const done = new TracedHostedAgent({ run: async () => ({ sessionId: "sess-1", status: "done", text: "ok", artifacts: [] }) }, "kimi_hosted_agents", "kimi-k3");
  const failed = new TracedHostedAgent({ run: async () => ({ sessionId: "sess-2", status: "failed", text: "", artifacts: [], error: "sandbox died" }) }, "kimi_hosted_agents", "kimi-k3");
  await done.run(task);
  await failed.run(task);
  const [a, b] = await spansNamed("hosted-agent.run");
  assert.equal(meta(a!, "provider_session_id"), "sess-1");
  assert.equal(meta(a!, "status"), "done");
  assert.equal(attr(a!, "model.name"), "kimi-k3");
  assert.equal(meta(b!, "provider_session_id"), "sess-2");
  assert.equal(attr(b!, "level"), "ERROR");
  assert.equal(attr(b!, "status_message"), "sandbox died");
});

const model = createKimiModel({ env: { LLM_API_KEY: "test-key" } } as never);
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const message = (text: string): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], api: model.api, provider: model.provider, model: model.id, usage, stopReason: "stop", timestamp: 0 });
const answer = (stream: ReturnType<typeof createAssistantMessageEventStream>, text: string) => {
  stream.push({ type: "start", partial: message("") });
  stream.push({ type: "done", reason: "stop", message: message(text) });
};

test("a retried provider call labels its generations with the attempt number", async () => {
  let requests = 0;
  const inner: StreamFn = (requestModel, context, options) => traceProviderStream(() => {
    const stream = createAssistantMessageEventStream();
    if (++requests === 1) stream.push({ type: "error", reason: "error", error: { ...message(""), stopReason: "error", errorMessage: "fetch failed" } } as AssistantMessageEvent);
    else answer(stream, "fine");
    return stream;
  }, requestModel, context, options);
  const stream = withStallGuard(inner, { firstEventMs: 200, silenceMs: 200, restarts: 1, backoffMs: 1 })(model, { messages: [] }, {}) as ReturnType<typeof createAssistantMessageEventStream>;
  for await (const _event of stream) { /* drain */ }
  const generations = await spansNamed("generate-response");
  assert.equal(generations.length, 2);
  assert.deepEqual(generations.map(span => [meta(span, "attempt"), meta(span, "retry")]), [["0", "false"], ["1", "true"]]);
});

test("compaction is a labelled observation with the summarizing model", async () => {
  const api = { stream: () => { const s = createAssistantMessageEventStream(); answer(s, "the summary"); return s; }, streamSimple: () => { const s = createAssistantMessageEventStream(); answer(s, "the summary"); return s; } };
  const models = createModels();
  models.setProvider(createProvider({ id: model.provider, name: "fake", baseUrl: model.baseUrl, auth: { apiKey: envApiKeyAuth("key", ["LLM_API_KEY"]) }, models: [model], api: api as never }));
  process.env.LLM_API_KEY ??= "test-key";
  const summarize = summarizeWithPi<{ role: "user"; content: string; timestamp: number }>(m => m as never, () => ({ models, model }));
  const text = await summarize({ messages: [{ role: "user", content: "hello there", timestamp: 0 }], instructions: "", signal: new AbortController().signal });
  assert.match(text, /summary/);
  const [span] = await spansNamed("compaction.summarize");
  assert.equal(attr(span!, "model.name"), model.id);
  assert.equal(meta(span!, "provider"), model.provider);
  assert.equal(meta(span!, "messages"), "1");
});

test("embedding and rerank calls are generations with DashScope usage", async () => {
  const gateway = http.createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/embeddings")) response.end(JSON.stringify({ data: [{ embedding: Array(1024).fill(0.1) }], usage: { prompt_tokens: 7, total_tokens: 7 } }));
      else if (request.url?.endsWith("/reranks")) response.end(JSON.stringify({ results: [{ index: 0, relevance_score: 0.9 }], usage: { total_tokens: 11 } }));
      else response.end(JSON.stringify({ result: { points: [{ id: "p1", score: 0.5, payload: { text: "chunk" } }] } }));
    });
  });
  await new Promise<void>(resolve => gateway.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    await new QdrantKnowledgeProvider(base, "q", "d", { embeddingBaseUrl: base, rerankBaseUrl: base }).search({ creatorId: "c", agentId: "a", corpusDigest: "sha256:x", query: "q", limit: 1 });
  } finally { await new Promise(resolve => gateway.close(resolve)); }
  const [embed] = await spansNamed("embed");
  assert.equal(attr(embed!, "model.name"), "text-embedding-v4");
  assert.match(String(attr(embed!, "usage_details")), /"input":7/);
  const [rerank] = await spansNamed("rerank");
  assert.equal(attr(rerank!, "model.name"), "qwen3-rerank");
  assert.match(String(attr(rerank!, "usage_details")), /"total":11/);
});

test("a failed export is one warning line, not one per batch", () => {
  const log: string[] = [];
  let clock = 0;
  const exporter = reportExportFailures({ export: (_spans, done) => done({ code: 1, error: new Error("401 unauthorized") }), shutdown: async () => {} }, line => log.push(line), () => clock, 1_000);
  const results: number[] = [];
  const send = () => exporter.export([], result => results.push(result.code));
  send(); send();
  assert.equal(log.length, 1);
  assert.deepEqual(JSON.parse(log[0]!), { event: "langfuse_export_failed", spans: 0, error: "401 unauthorized" });
  clock = 1_500; send();
  assert.equal(log.length, 2);
  assert.deepEqual(results, [1, 1, 1]);
});

test("the exporter the SDK was started with is the reporting one", async () => {
  const original = console.error;
  console.error = (line: string) => { lines.push(line); };
  failExports = true;
  try {
    await traceGeneration("export-fails", { model: "m" }, async () => 1);
    await flushLangfuseObservability().catch(() => undefined);
  } finally { failExports = false; console.error = original; }
  assert.ok(lines.some(line => line.includes("langfuse_export_failed")));
});
