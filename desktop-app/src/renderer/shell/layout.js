// Application zoom is separate from OS display scaling: a bounded per-window
// WebView scale in whole 10% steps (never an arbitrary fractional factor).
export const DESKTOP_ZOOM = Object.freeze({ min: 0.8, max: 1.5, step: 0.1, default: 1 });
export const ZOOM_OPTIONS = Object.freeze([0.9, 1, 1.1, 1.25, 1.5]);

export function normalizeZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DESKTOP_ZOOM.default;
  return Math.round(Math.min(DESKTOP_ZOOM.max, Math.max(DESKTOP_ZOOM.min, numeric)) * 100) / 100;
}

export function nextZoom(value, direction) {
  return normalizeZoom(normalizeZoom(value) + (direction === "decrease" ? -DESKTOP_ZOOM.step : DESKTOP_ZOOM.step));
}
