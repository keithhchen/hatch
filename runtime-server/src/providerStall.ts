import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";

/** How long a provider call may say nothing: before its first event, and between any two events. */
export type StallLimits = { firstEventMs: number; silenceMs: number; /** How often a call with no first event is issued again before it fails; never when absent. */ restarts?: number };

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
 * already turns into an upstream failure; the provider's own events pass through untouched. A call with no first event has
 * emitted nothing, so it is issued again (`restarts` times) before it fails.
 */
export const withStallGuard = (inner: StreamFn, limits: StallLimits = DEFAULT_STALL_LIMITS): StreamFn => (model, context, options) => {
  const out = createAssistantMessageEventStream();
  let request = new AbortController();
  const fail = (message: string): void => {
    request.abort();
    out.push({ type: "error", reason: "error", error: failed(model, message) });
    out.end();
  };
  /** Passes an opened stream through, failing it if it goes silent. */
  const relay = async (events: AsyncIterator<AssistantMessageEvent>, first: IteratorResult<AssistantMessageEvent>): Promise<void> => {
    for (let next = first; ; ) {
      if (next.done) return out.end();
      out.push(next.value);
      const after = await within(events.next(), limits.silenceMs);
      if (after === STALLED) return fail(`${model.id} stream timed out: no event within ${limits.silenceMs}ms`);
      next = after;
    }
  };
  void (async () => {
    for (let restarts = limits.restarts ?? 0; ; restarts--) {
      request = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
      const open = await within((async () => {
        const events = (await inner(model, context, { ...options, signal }))[Symbol.asyncIterator]();
        return { events, first: await events.next() };
      })(), limits.firstEventMs);
      if (open !== STALLED) return relay(open.events, open.first);
      request.abort();
      if (restarts <= 0 || options?.signal?.aborted) return fail(`${model.id} stream timed out: no first event within ${limits.firstEventMs}ms`);
    }
  })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  return out;
};
