let active = null;
let enabled = false;
const pending = [];
const MAX_PENDING = 50;

// Until the SDK arrives, calls wait here and are replayed in order by initSentry.
const withSentry = (fn) => {
  if (active) fn(active);
  else if (enabled && pending.length < MAX_PENDING) pending.push(fn);
};

// Browser -> Sentry directly (never through our backend). Without a DSN
// (local dev, tests) nothing is initialized and reporting is a no-op.
export function initSentry(env, sentry) {
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
  pending.splice(0).forEach((fn) => fn(sentry));
  return true;
}

// The SDK (~45 kB gzip) is its own chunk, fetched right after the first render so it never weighs on the entry.
// Errors thrown before it arrives are queued from window listeners and reported once it is up (the SDK's own
// global handlers take over from then on).
export function startSentry(env, load = () => import("./sentrySdk.js"), target = globalThis) {
  if (!env.VITE_SENTRY_DSN) return Promise.resolve(false);
  enabled = true;
  const onError = (event) => withSentry((sentry) => sentry.captureException(event.error ?? new Error(event.message)));
  const onRejection = (event) => withSentry((sentry) => sentry.captureException(event.reason));
  target.addEventListener?.("error", onError);
  target.addEventListener?.("unhandledrejection", onRejection);
  return new Promise((resolve) => setTimeout(resolve, 0))
    .then(load)
    .then((sentry) => initSentry(env, sentry))
    .catch(() => false)
    .finally(() => {
      target.removeEventListener?.("error", onError);
      target.removeEventListener?.("unhandledrejection", onRejection);
    });
}

// Correlates a failed API response with backend telemetry via request_id.
// Metadata only: no request or response bodies.
export function reportRequestFailure(error, { method, path, capture }) {
  withSentry((sentry) => {
    const data = { method, path, status: error.status, request_id: error.request_id };
    sentry.addBreadcrumb({ category: "http", level: "error", message: `${method} ${path}`, data });
    if (!capture) return;
    sentry.withScope((scope) => {
      scope.setTag("request_id", error.request_id ?? "unknown");
      scope.setTag("http_status", String(error.status));
      scope.setContext("request", data);
      sentry.captureException(error);
    });
  });
}

export function captureRenderError(error, details) {
  withSentry((sentry) => sentry.captureException(error, { contexts: { react: { componentStack: details?.componentStack } } }));
}

// A tab on an older build hit a missing chunk; reported so deploy-time recovery frequency is visible.
export function reportStaleBuild({ build, reloading }) {
  withSentry((sentry) => sentry.captureMessage("Stale build chunk failed to load", { level: "warning", tags: { stale_build_reloading: String(reloading) }, extra: { build } }));
}
