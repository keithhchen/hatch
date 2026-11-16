import { noopAnalytics } from "./noop.js";
import type { ProductAnalytics } from "./port.js";

/** Whatever adapter is given, what comes back never throws: a broken analytics must not break a run, a request or a publish. Absent means nothing is sent. */
export function safely(analytics: ProductAnalytics | undefined): ProductAnalytics {
  if (!analytics) return noopAnalytics;
  return {
    capture(distinctId, event) { try { analytics.capture(distinctId, event); } catch { /* lost, not raised */ } },
    async shutdown(timeoutMs) { try { await analytics.shutdown(timeoutMs); } catch { /* the process is ending anyway */ } }
  };
}
