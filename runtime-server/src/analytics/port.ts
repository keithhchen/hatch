/** One product event: its catalog name and its properties. Built only by `events.ts`. */
export type AnalyticsEvent = readonly [event: string, props: Record<string, unknown>];

/** Product analytics as the product sees it. Sending is fire-and-forget: it returns at once, never throws, and loses events rather than slow anything. */
export interface ProductAnalytics {
  capture(distinctId: string, event: AnalyticsEvent): void;
  /** Sends what is queued, waiting at most `timeoutMs`. */
  shutdown(timeoutMs: number): Promise<void>;
}
