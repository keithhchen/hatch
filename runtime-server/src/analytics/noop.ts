import type { ProductAnalytics } from "./port.js";

/** Analytics that is not configured: local development and tests. */
export const noopAnalytics: ProductAnalytics = { capture: () => undefined, shutdown: async () => undefined };
