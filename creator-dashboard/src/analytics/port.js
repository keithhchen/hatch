/**
 * @typedef {[name: string, props: Record<string, string | number | boolean>]} AnalyticsEvent  A catalog tuple from events.js.
 *
 * @typedef {object} Analytics  Send-and-forget product analytics: nothing returns a Promise and nothing throws.
 * @property {(accountId: string) => void} identify
 * @property {() => void} reset
 * @property {(event: AnalyticsEvent) => void} track
 */
export {};
