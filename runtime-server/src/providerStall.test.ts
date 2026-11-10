import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createKimiModel } from "./piModel.js";
import { withStallGuard } from "./providerStall.js";
import { UpstreamError } from "./errors/upstream.js";
import { failures, UPSTREAM_CODE } from "./errors/failures.js";
import { resolveLlmProfile } from "./llmProfiles.js";

const limits = { firstEventMs: 40, silenceMs: 40 };
const model = createKimiModel({ env: { LLM_API_KEY: "test-key" } } as never);
const partial = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: {}, stopReason: "stop", timestamp: 0 } as unknown as AssistantMessage;
const call = (stub: StreamFn, signal?: AbortSignal) => withStallGuard(stub, limits)(model, { messages: [] }, { signal }) as ReturnType<typeof createAssistantMessageEventStream>;
const drain = async (stream: ReturnType<typeof call>): Promise<AssistantMessageEvent[]> => {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

/** A provider whose request stays open until the guard aborts it. */
const hangs = (seen: { aborted: boolean }, before: AssistantMessageEvent[] = []): StreamFn => (_model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  for (const event of before) stream.push(event);
  options?.signal?.addEventListener("abort", () => { seen.aborted = true; });
  return stream;
};

test("a provider that never sends is aborted and fails as an upstream error with a reference", async () => {
  const seen = { aborted: false };
  const started = Date.now();
  const stream = call(hangs(seen));
  const events = await drain(stream);
  const result = await stream.result();
  assert.ok(Date.now() - started < 1_000);
  assert.deepEqual(events.map((event) => event.type), ["error"]);
  assert.equal(result.stopReason, "error");
  assert.equal(seen.aborted, true);
  const upstream = UpstreamError.of(result.errorMessage, `${result.provider} ${result.model}`);
  assert.equal(upstream.kind, "transient");
  assert.equal(upstream.provider, "moonshot");
  const failure = failures.translate(upstream);
  assert.equal(failure.code, UPSTREAM_CODE);
  assert.match(failure.reference ?? "", /^err_/);
  assert.doesNotMatch(failure.message, /timed out|kimi/);
});

test("a provider that goes silent mid-stream keeps what it sent and then fails", async () => {
  const seen = { aborted: false };
  const events = await drain(call(hangs(seen, [{ type: "start", partial }, { type: "text_start", contentIndex: 0, partial }])));
  assert.deepEqual(events.map((event) => event.type), ["start", "text_start", "error"]);
  assert.match((events.at(-1) as { error: AssistantMessage }).error.errorMessage ?? "", /no event within 40ms/);
  assert.equal(seen.aborted, true);
});

test("a provider that keeps sending is never cut off, however long it takes in all", async () => {
  const slow: StreamFn = () => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      for (let n = 0; n < 6; n++) { stream.push({ type: "start", partial }); await new Promise((resolve) => setTimeout(resolve, 20)); }
      stream.push({ type: "done", reason: "stop", message: partial });
    })();
    return stream;
  };
  const events = await drain(call(slow));
  assert.equal(events.at(-1)?.type, "done");
  assert.equal(events.length, 7);
});

test("the caller's own abort still reaches the provider", async () => {
  const seen = { aborted: false };
  const controller = new AbortController();
  const stream = call(hangs(seen), controller.signal);
  controller.abort();
  await drain(stream);
  assert.equal(seen.aborted, true);
});

test("an upstream failure names the provider that was called even when its error text does not", () => {
  assert.equal(UpstreamError.of("Connection error.", "kimi kimi-k2.6").provider, "moonshot");
});

/** A provider that sends `events`, one every `gapMs`, then finishes. */
const sends = (events: AssistantMessageEvent[], gapMs: number): StreamFn => () => {
  const stream = createAssistantMessageEventStream();
  void (async () => {
    for (const event of events) { await new Promise((resolve) => setTimeout(resolve, gapMs)); stream.push(event); }
    stream.push({ type: "done", reason: "stop", message: partial });
  })();
  return stream;
};

test("thinking events keep the guard alive while the model reasons", async () => {
  const thinking: AssistantMessageEvent[] = [
    { type: "start", partial }, { type: "thinking_start", contentIndex: 0, partial },
    ...Array.from({ length: 5 }, () => ({ type: "thinking_delta", contentIndex: 0, delta: "…", partial }) as AssistantMessageEvent),
    { type: "thinking_end", contentIndex: 0, content: "…", partial }
  ];
  const events = await drain(withStallGuard(sends(thinking, 25), limits)(model, { messages: [] }, {}) as ReturnType<typeof call>);
  assert.equal(events.filter((event) => event.type === "thinking_delta").length, 5);
  assert.equal(events.at(-1)?.type, "done");
});

test("the first event and the silence between events have their own limits", async () => {
  const lateFirst = withStallGuard(sends([{ type: "start", partial }], 70), { firstEventMs: 200, silenceMs: 40 });
  assert.equal((await drain(lateFirst(model, { messages: [] }, {}) as ReturnType<typeof call>)).at(-1)?.type, "done");
  const failedFirst = withStallGuard(hangs({ aborted: false }), { firstEventMs: 40, silenceMs: 200 });
  assert.equal((await drain(failedFirst(model, { messages: [] }, {}) as ReturnType<typeof call>)).at(-1)?.type, "error");
});

test("a reasoning Gemini profile asks again when its first event never comes, and still bounds it", () => {
  const { stall } = resolveLlmProfile({ HATCH_LLM_PROFILE: "gemini-3.1-pro" });
  assert.ok(stall && Number.isFinite(stall.firstEventMs) && (stall.restarts ?? 0) > 0);
  assert.equal(resolveLlmProfile({ HATCH_LLM_PROFILE: "kimi-k2.6-no-thinking" }).stall, undefined);
});

/** A provider whose first `hung` requests never answer and whose next one answers; `seen` counts the requests. */
const hangsThenAnswers = (hung: number, seen: { requests: number; aborted: number }): StreamFn => (_model, _context, options) => {
  const stream = createAssistantMessageEventStream();
  if (++seen.requests <= hung) { options?.signal?.addEventListener("abort", () => { seen.aborted++; }); return stream; }
  stream.push({ type: "start", partial });
  stream.push({ type: "done", reason: "stop", message: partial });
  return stream;
};
const guarded = (stub: StreamFn, restarts: number) => drain(withStallGuard(stub, { ...limits, restarts })(model, { messages: [] }, {}) as ReturnType<typeof call>);

test("a call with no first event is aborted and issued again; the answer of the new call reaches the caller", async () => {
  const seen = { requests: 0, aborted: 0 };
  assert.deepEqual((await guarded(hangsThenAnswers(2, seen), 2)).map((event) => event.type), ["start", "done"]);
  assert.deepEqual(seen, { requests: 3, aborted: 2 });
});

test("a provider that never answers any of the restarts still fails with the one error", async () => {
  const seen = { requests: 0, aborted: 0 };
  assert.deepEqual((await guarded(hangsThenAnswers(99, seen), 1)).map((event) => event.type), ["error"]);
  assert.equal(seen.requests, 2);
});

test("a stream that went silent after its first event is not issued again", async () => {
  assert.deepEqual((await guarded(hangs({ aborted: false }, [{ type: "start", partial }]), 2)).map((event) => event.type), ["start", "error"]);
});
