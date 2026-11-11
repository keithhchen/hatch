import type { StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEvent, type Model } from "@earendil-works/pi-ai";
import { UpstreamError } from "./errors/upstream.js";
import { labelAttempt } from "./langfuse.js";

/** How long a provider call may say nothing: before its first event, and between any two events. */
export type StallLimits = {
  firstEventMs: number;
  silenceMs: number;
  /** How often a call that produced nothing (no first event, or a transient failure as its first event) is issued again before it fails; never when absent. */
  restarts?: number;
  /** The wait before issuing a call again after a transient failure; it doubles with each restart. */
  backoffMs?: number;
};

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

/** Waits `ms`, or until the caller's own signal aborts. */
const pause = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

type Opened = { events: AsyncIterator<AssistantMessageEvent>; first: IteratorResult<AssistantMessageEvent> } | { failure: unknown };

/** A call that failed in a way worth asking again, before it said anything: the call threw, or its first event is the error. */
const transientBeforeOutput = (model: Model<Api>, opened: Opened): boolean => {
  const failure = "failure" in opened ? opened.failure
    : !opened.first.done && opened.first.value.type === "error" ? opened.first.value.error.errorMessage : undefined;
  return failure !== undefined && UpstreamError.of(failure, `${model.provider} ${model.id}`).kind === "transient";
};

/**
 * Bounds a provider call. A stream that sends nothing for too long is aborted and ends as the error result the Agent
 * already turns into an upstream failure; the provider's own events pass through untouched. A call that has emitted nothing is
 * issued again (`restarts` times, after a backoff when it failed) before it fails: one with no first event, and one whose first
 * event is a transient failure such as a dropped connection. Once an event is out, a call is never issued again: it would repeat text.
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
    for (let restarts = limits.restarts ?? 0, attempt = 0; ; restarts--, attempt++) {
      request = new AbortController();
      const signal = options?.signal ? AbortSignal.any([options.signal, request.signal]) : request.signal;
      const open = await within((async (): Promise<Opened> => {
        try {
          const events = (await labelAttempt(attempt, () => inner(model, context, { ...options, signal })))[Symbol.asyncIterator]();
          return { events, first: await events.next() };
        } catch (failure) { return { failure }; }
      })(), limits.firstEventMs);
      const again = restarts > 0 && !options?.signal?.aborted;
      if (open !== STALLED && !(again && transientBeforeOutput(model, open))) {
        if ("failure" in open) throw open.failure;
        return relay(open.events, open.first);
      }
      request.abort();
      if (open === STALLED) {
        if (!again) return fail(`${model.id} stream timed out: no first event within ${limits.firstEventMs}ms`);
      } else await pause((limits.backoffMs ?? 500) * 2 ** attempt, options?.signal);
    }
  })().catch((error) => fail(error instanceof Error ? error.message : String(error)));
  return out;
};
