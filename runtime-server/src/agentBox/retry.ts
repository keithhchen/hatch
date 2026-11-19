import { log } from "../observability/log.js";
import { BoxUnavailable } from "./ports.js";

/** A failure before the call did anything: safe to run again. */
export class Transient extends Error {
  /** The service's rate limit, which needs the longer waits. */
  readonly limited: boolean;
  constructor(message: string, options?: { cause?: unknown; limited?: boolean }) { super(message, { cause: options?.cause }); this.limited = options?.limited ?? false; }
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal?.reason); };
  signal?.addEventListener("abort", onAbort, { once: true });
});

export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export const unavailable = (error: unknown): never => {
  log.error("agent_box_failed", { error });
  throw new BoxUnavailable(error);
};

/** Runs `attempt` again after each backoff while it fails with Transient; the last Transient is BoxUnavailable. Stops on abort, or when waiting would pass `withinMs` in all. */
export async function retrying<T>(what: string, backoff: number[], attempt: () => Promise<T>, signal?: AbortSignal, withinMs = Infinity, limitBackoff = backoff): Promise<T> {
  const started = Date.now();
  for (let retry = 0; ; retry++) {
    try { return await attempt(); } catch (error) {
      if (!(error instanceof Transient)) throw error;
      const delay = (error.limited ? limitBackoff : backoff)[retry];
      if (delay === undefined || Date.now() - started + delay > withinMs) return unavailable(error.cause);
      log.warn("agent_box_retry", { what, retry: retry + 1, delayMs: delay, error: error.message });
      await sleep(delay, signal);
    }
  }
}
