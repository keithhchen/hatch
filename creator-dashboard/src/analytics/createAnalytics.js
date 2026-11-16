import { noopAnalytics } from "./noopAnalytics.js";
import { createPostHogAnalytics } from "./posthogAnalytics.js";

// Like sentry.js: without a key (local dev, tests) nothing is initialized.
export function createAnalytics(env, createAdapter = createPostHogAnalytics) {
  return env.VITE_POSTHOG_KEY ? createAdapter(env.VITE_POSTHOG_KEY) : noopAnalytics;
}
