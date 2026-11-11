import type { ServerResponse } from "node:http";

/** One shutdown, in order: stop being asked for work, finish what is held (bounded), let go of connections and storage. */
export type ShutdownSteps = {
  /** Health checks fail from here on, so the proxy sends nothing new. */
  markUnready(): void;
  /** Stops intake: no new connections, no background loop or listener claims more work. Must not wait for open connections. */
  stopIntake(): Promise<void>;
  /** Resolves when the work this process holds has finished. */
  drain(): Promise<void>;
  /** Ends long-lived streams and sockets cleanly; clients reconnect to the new instance. */
  closeConnections(): Promise<void>;
  /** Releases pools and anything else the process owns; Runs still held are handed to the next instance. */
  closeStorage(): Promise<void>;
  /** The longest drain may take. */
  deadlineMs: number;
  onError?(step: string, error: unknown): void;
};

export async function gracefulShutdown(steps: ShutdownSteps): Promise<{ drained: boolean }> {
  const attempt = async (name: string, step: () => Promise<void> | void): Promise<void> => {
    try { await step(); } catch (error) { steps.onError?.(name, error); }
  };
  await attempt("markUnready", steps.markUnready);
  await attempt("stopIntake", steps.stopIntake);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), steps.deadlineMs); });
  const finished = steps.drain().then(() => true, (error): boolean => { steps.onError?.("drain", error); return true; });
  const drained = await Promise.race([finished, deadline]);
  clearTimeout(timer);
  await attempt("closeConnections", steps.closeConnections);
  await attempt("closeStorage", steps.closeStorage);
  return { drained };
}

/** Runs `shutdown` once on SIGTERM or SIGINT, then exits. */
export function exitOnSignal(shutdown: () => Promise<unknown>): void {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}

export const drainMsFromEnvironment = (environment: NodeJS.ProcessEnv): number => {
  const value = Number(environment.HATCH_DRAIN_MS);
  return Number.isInteger(value) && value > 0 ? value : 90_000;
};

/** The responses a server has open: requests are waited for, event streams are ended so clients reconnect. */
export class InflightResponses {
  private readonly open = new Set<ServerResponse>();

  track(response: ServerResponse): void {
    this.open.add(response);
    response.once("close", () => this.open.delete(response));
  }

  private isStream(response: ServerResponse): boolean {
    // Headers given to writeHead() are not visible to getHeader(); the sent header block is.
    const sent = (response as unknown as { _header?: string })._header ?? "";
    return String(response.getHeader("content-type") ?? "").includes("text/event-stream") || sent.includes("text/event-stream");
  }

  /** Resolves once every open response that is not a stream has finished. */
  async requestsDone(pollMs = 50): Promise<void> {
    while ([...this.open].some(response => !this.isStream(response))) await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  /** A clean end for a stream (the client reconnects with its last event id); whatever else is still open past the deadline is cut. */
  endAll(): void {
    for (const response of this.open) { if (response.headersSent) response.end(); else response.destroy(); }
  }
}
