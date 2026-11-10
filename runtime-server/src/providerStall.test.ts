import assert from "node:assert/strict";
import { test } from "node:test";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createKimiModel } from "./piModel.js";
import { withStallGuard } from "./providerStall.js";
import { UpstreamError } from "./errors/upstream.js";
import { failures, UPSTREAM_CODE } from "./errors/failures.js";

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
