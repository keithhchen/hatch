import { noopAnalytics } from "./noop.js";
import type { ProductAnalytics } from "./port.js";
import { PostHogAnalytics } from "./posthog.js";

export type { AnalyticsEvent, ProductAnalytics } from "./port.js";
export { noopAnalytics } from "./noop.js";

/** PostHog when `POSTHOG_PROJECT_API_KEY` is set, otherwise nothing is sent. */
export function createProductAnalytics(env: NodeJS.ProcessEnv = process.env): ProductAnalytics {
  const key = env.POSTHOG_PROJECT_API_KEY?.trim();
  return key ? new PostHogAnalytics(key) : noopAnalytics;
}
