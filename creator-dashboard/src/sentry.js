import { addBreadcrumb, browserTracingIntegration, captureException, init, withScope } from "@sentry/react";

// Named imports, not `import *`: a namespace object keeps Replay and Feedback in the entry bundle.
const Sentry = { addBreadcrumb, browserTracingIntegration, captureException, init, withScope };

let active = null;

// Browser -> Sentry directly (never through our backend). Without a DSN
// (local dev, tests) nothing is initialized and reporting is a no-op.
export function initSentry(env, sentry = Sentry) {
  if (!env.VITE_SENTRY_DSN) return false;
  const production = Boolean(env.PROD);
  sentry.init({
    dsn: env.VITE_SENTRY_DSN,
    environment: production ? "production" : "development",
    release: env.VITE_RELEASE || undefined,
    integrations: [sentry.browserTracingIntegration()],
    tracesSampleRate: production ? 0.2 : 1.0,
    tracePropagationTargets: [globalThis.location.origin],
    sendDefaultPii: false
  });
  active = sentry;
  return true;
}

// Correlates a failed API response with backend telemetry via request_id.
// Metadata only: no request or response bodies.
export function reportRequestFailure(error, { method, path, capture }) {
  if (!active) return;
  const data = { method, path, status: error.status, request_id: error.request_id };
  active.addBreadcrumb({ category: "http", level: "error", message: `${method} ${path}`, data });
  if (!capture) return;
  active.withScope((scope) => {
    scope.setTag("request_id", error.request_id ?? "unknown");
    scope.setTag("http_status", String(error.status));
    scope.setContext("request", data);
    active.captureException(error);
  });
}

export function captureRenderError(error, details) {
  active?.captureException(error, { contexts: { react: { componentStack: details?.componentStack } } });
}
