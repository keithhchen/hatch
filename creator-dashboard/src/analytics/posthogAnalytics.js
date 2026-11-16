// The only file that knows PostHog. The SDK is its own chunk, fetched once the page is idle, so it never weighs on the
// first paint; calls made before it arrives wait for it. Every call is send-and-forget: a failing SDK never reaches the product.
const OPTIONS = {
  api_host: "/relay",
  ui_host: "https://us.posthog.com",
  defaults: "2026-08-30",
  autocapture: false,
  // Heatmaps record where people click and how far they scroll (positions only, no text); clickmaps would need autocapture, which stays off.
  capture_heatmaps: true,
  disable_session_recording: true,
  disable_surveys: true,
  advanced_disable_flags: true,
  person_profiles: "identified_only",
  capture_pageleave: true
};

const whenIdle = (fn) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(fn, { timeout: 3000 }) : setTimeout(fn, 1500));

/** @returns {import("./port.js").Analytics} */
export function createPostHogAnalytics(key, load = () => import("posthog-js").then((module) => module.default)) {
  const client = new Promise((resolve) => whenIdle(resolve))
    .then(load)
    .then((posthog) => { posthog.init(key, OPTIONS); return posthog; });
  client.catch(() => undefined);
  const later = (fn) => (...args) => { client.then((posthog) => fn(posthog, ...args)).catch(() => undefined); };
  return {
    identify: later((posthog, accountId) => posthog.identify(accountId)),
    reset: later((posthog) => posthog.reset()),
    track: later((posthog, [name, props]) => posthog.capture(name, props))
  };
}
