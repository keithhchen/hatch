import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Model } from "@earendil-works/pi-ai";

/** How long a provider call may say nothing: before its first event, and between any two events. */
export type StallLimits = { firstEventMs: number; silenceMs: number };

export const DEFAULT_STALL_LIMITS: StallLimits = { firstEventMs: 60_000, silenceMs: 60_000 };

const STALLED = Symbol("stalled");

/** `work`, or STALLED once `ms` pass without it settling. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof STALLED> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<typeof STALLED>((resolve) => { timer = setTimeout(() => resolve(STALLED), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

const failed = (model: Model<Api>, errorMessage: string): AssistantMessage => ({
  role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "error", errorMessage, timestamp: Date.now()
});

/**
 * Bounds a provider call. A stream that sends nothing for too long is aborted and ends as the error result the Agent
 * already turns into an upstream failure; the provider's own events pass through untouched.
 */
export const withStallGuard = (inner: StreamFn, limits: StallLimits = DEFAULT_STALL_LIMITS): StreamFn => (model, context, options) => {
  const out = createAssistantMessageEventStream();
  const request = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
  const fail = (message: string): void => {
    request.abort();
    out.push({ type: "error", reason: "error", error: failed(model, message) });
    out.end();
  };
  void (async () => {
    const started = await within(Promise.resolve(inner(model, context, { ...options, signal })), limits.firstEventMs);
    if (started === STALLED) return fail(`${model.id} stream timed out: no response within ${limits.firstEventMs}ms`);
    const events = started[Symbol.asyncIterator]();
    for (let first = true; ; first = false) {
      const ms = first ? limits.firstEventMs : limits.silenceMs;
      const next = await within(events.next(), ms);
      if (next === STALLED) return fail(`${model.id} stream timed out: no ${first ? "first " : ""}event within ${ms}ms`);
      if (next.done) return out.end();
      out.push(next.value);
    }
  })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  return out;
};
