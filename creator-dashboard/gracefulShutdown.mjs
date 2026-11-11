// The Dashboard's copy of runtime-server/src/gracefulShutdown.ts (separate package, same contract).

/** One shutdown, in order: stop being asked for work, finish what is held (bounded), let go of connections and storage. */
export async function gracefulShutdown({ markUnready, stopIntake, drain, closeConnections, closeStorage, deadlineMs, onError }) {
  const attempt = async (name, step) => {
    try { await step(); } catch (error) { onError?.(name, error); }
  };
  await attempt("markUnready", markUnready);
  await attempt("stopIntake", stopIntake);
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve(false), deadlineMs); });
  const finished = drain().then(() => true, error => { onError?.("drain", error); return true; });
  const drained = await Promise.race([finished, deadline]);
  clearTimeout(timer);
  await attempt("closeConnections", closeConnections);
  await attempt("closeStorage", closeStorage);
  return { drained };
}

/** Runs `shutdown` once on SIGTERM or SIGINT, then exits. */
export function exitOnSignal(shutdown) {
  let shuttingDown = false;
  const handle = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void shutdown().finally(() => process.exit(0));
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}

export const drainMsFromEnvironment = environment => {
  const value = Number(environment.HATCH_DRAIN_MS);
  return Number.isInteger(value) && value > 0 ? value : 90_000;
};

/** The responses a server has open: requests are waited for, event streams are ended so clients reconnect. */
export class InflightResponses {
  open = new Set();

  track(response) {
    this.open.add(response);
    response.once("close", () => this.open.delete(response));
  }

  isStream(response) {
    // Headers given to writeHead() are not visible to getHeader(); the sent header block is.
    return String(response.getHeader("content-type") ?? "").includes("text/event-stream") || String(response._header ?? "").includes("text/event-stream");
  }

  /** Resolves once every open response that is not a stream has finished. */
  async requestsDone(pollMs = 50) {
    while ([...this.open].some(response => !this.isStream(response))) await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  /** A clean end for a stream (the client reconnects); whatever else is still open past the deadline is cut. */
  endAll() {
    for (const response of this.open) { if (response.headersSent) response.end(); else response.destroy(); }
  }
}
