import type { AnalyticsEvent, ProductAnalytics } from "./port.js";

/** A fake for tests: remembers what was captured. */
export class RecordingAnalytics implements ProductAnalytics {
  readonly captured: Array<{ distinctId: string; event: string; props: Record<string, unknown> }> = [];
  capture(distinctId: string, [event, props]: AnalyticsEvent): void { this.captured.push({ distinctId, event, props }); }
  async shutdown(): Promise<void> { return; }
  names(): string[] { return this.captured.map(entry => entry.event); }
}

/** A fake whose every call throws: a run must not notice. */
export const throwingAnalytics: ProductAnalytics = {
  capture: () => { throw new Error("analytics down"); },
  shutdown: async () => { throw new Error("analytics down"); }
};
