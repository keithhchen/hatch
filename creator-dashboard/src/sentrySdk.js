import { addBreadcrumb, browserTracingIntegration, captureException, captureMessage, init, withScope } from "@sentry/react";

// Named imports, not `import *`: a namespace object keeps Replay and Feedback in the bundle.
export { addBreadcrumb, browserTracingIntegration, captureException, captureMessage, init, withScope };
