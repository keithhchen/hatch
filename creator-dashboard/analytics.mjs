import { PostHog } from "posthog-node";
import { logEvent } from "./observability.mjs";

const INGEST_HOST = "https://us.i.posthog.com";

/** The port: `capture(distinctId, { event, properties })` never throws and is never awaited; `shutdown(ms)` flushes, bounded. */
const noopAnalytics = { capture() {}, shutdown: async () => {} };

/** The PostHog adapter (the only file that imports posthog-node), or a noop when no project key is set. */
export function createServerAnalytics(env = process.env) {
  const apiKey = env.POSTHOG_PROJECT_API_KEY;
  if (!apiKey) return noopAnalytics;
  const client = new PostHog(apiKey, { host: INGEST_HOST, flushAt: 20, flushInterval: 5000, disableGeoip: true });
  let reported = false;
  const reportOnce = error => {
    if (reported) return;
    reported = true;
    logEvent("warn", "analytics_failed", { message: error instanceof Error ? error.message : String(error) });
  };
  client.on("error", reportOnce);
  return {
    capture(distinctId, { event, properties }) {
      try { client.capture({ distinctId: String(distinctId), event, properties }); } catch (error) { reportOnce(error); }
    },
    async shutdown(timeoutMs = 3000) {
      try { await client.shutdown(timeoutMs); } catch (error) { reportOnce(error); }
    }
  };
}
