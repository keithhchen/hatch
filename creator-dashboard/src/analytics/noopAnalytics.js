/** @type {import("./port.js").Analytics} */
export const noopAnalytics = Object.freeze({ identify() {}, reset() {}, track() {} });
