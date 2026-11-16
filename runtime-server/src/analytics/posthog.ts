import { PostHog } from "posthog-node";
import { log } from "../observability/log.js";
import type { AnalyticsEvent, ProductAnalytics } from "./port.js";

export const POSTHOG_HOST = "https://us.i.posthog.com";

/** PostHog US Cloud. The only file that imports its SDK. Events are batched and sent in the background; a failure is logged once and never reaches the caller. */
export class PostHogAnalytics implements ProductAnalytics {
  private readonly client: PostHog;
  private failed = false;

  constructor(projectApiKey: string, host = POSTHOG_HOST) {
    this.client = new PostHog(projectApiKey, { host, flushAt: 20, flushInterval: 5000, disableGeoip: true });
    this.client.on("error", error => this.failure("error", error));
  }

  capture(distinctId: string, [event, properties]: AnalyticsEvent): void {
    try { this.client.capture({ distinctId, event, properties }); } catch (error) { this.failure("capture", error); }
  }

  async shutdown(timeoutMs: number): Promise<void> {
    try { await this.client.shutdown(timeoutMs); } catch (error) { this.failure("shutdown", error); }
  }

  private failure(step: string, error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    log.warn("analytics_failed", { step, error });
  }
}
