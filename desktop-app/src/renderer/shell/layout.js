export const DESKTOP_LAYOUT = Object.freeze({
  windowMinWidth: 640,
  windowMinHeight: 600,
  mainMin: 640,
  sidebar: Object.freeze({ min: 216, preferred: 248, max: 360, default: 272 }),
  inspector: Object.freeze({ min: 240, preferred: 288, max: 480, default: 320 }),
  hysteresis: 32,
  keyboardStep: 16
});

export const LAYOUT_TIERS = Object.freeze({
  REGULAR: "regular",
  COMPACT: "compact",
  MINIMAL: "minimal"
});

// Application zoom is deliberately separate from OS display scaling. The
// native window keeps its logical dimensions while the WebView content gets a
// bounded, per-window scale that can be restored without changing the shell's
// responsive tier.
export const DESKTOP_ZOOM = Object.freeze({
  min: 0.8,
  max: 2,
  step: 0.1,
  default: 1
});

export function layoutThresholds(constraints = DESKTOP_LAYOUT) {
  return Object.freeze({
    compact: constraints.mainMin + constraints.sidebar.min,
    regular: constraints.mainMin + constraints.sidebar.preferred + constraints.inspector.min
  });
}

/**
 * Derives a stable desktop composition from the shell's own inline size. It
 * deliberately knows nothing about viewport breakpoints: an embedded window,
 * display zoom, and a resized desktop window all use the same contract.
 */
export function layoutTierForWidth(width, previousTier, constraints = DESKTOP_LAYOUT) {
  const inlineSize = Number.isFinite(Number(width)) ? Number(width) : 0;
  const previous = Object.values(LAYOUT_TIERS).includes(previousTier)
    ? previousTier
    : null;
  const { compact, regular } = layoutThresholds(constraints);
  const hysteresis = constraints.hysteresis;

  if (previous === LAYOUT_TIERS.REGULAR) {
    return inlineSize < regular - hysteresis ? LAYOUT_TIERS.COMPACT : LAYOUT_TIERS.REGULAR;
  }
  if (previous === LAYOUT_TIERS.COMPACT) {
    if (inlineSize >= regular + hysteresis) return LAYOUT_TIERS.REGULAR;
    if (inlineSize < compact - hysteresis) return LAYOUT_TIERS.MINIMAL;
    return LAYOUT_TIERS.COMPACT;
  }
  if (previous === LAYOUT_TIERS.MINIMAL) {
    return inlineSize >= compact + hysteresis ? LAYOUT_TIERS.COMPACT : LAYOUT_TIERS.MINIMAL;
  }
  if (inlineSize >= regular) return LAYOUT_TIERS.REGULAR;
  if (inlineSize >= compact) return LAYOUT_TIERS.COMPACT;
  return LAYOUT_TIERS.MINIMAL;
}

export function clampPaneWidth(kind, width, constraints = DESKTOP_LAYOUT) {
  const pane = constraints[kind];
  if (!pane) throw new Error(`Unknown desktop pane: ${kind}`);
  const numeric = Number(width);
  if (!Number.isFinite(numeric)) return pane.default;
  return Math.round(Math.min(pane.max, Math.max(pane.min, numeric)));
}

export function resetPaneWidth(kind, constraints = DESKTOP_LAYOUT) {
  const pane = constraints[kind];
  if (!pane) throw new Error(`Unknown desktop pane: ${kind}`);
  return pane.default;
}

/**
 * Resolves the visible representation of a pane without overwriting a user's
 * saved preference. In compact/minimal the inspector becomes a transient
 * overlay; in minimal both side panes are overlays.
 */
export function panePresentation({ tier, pane, preference = "open", overlayOpen = false }) {
  const wantsPane = preference === "open";
  if (!wantsPane) return "hidden";
  if (pane === "sidebar") {
    if (tier === LAYOUT_TIERS.MINIMAL) return overlayOpen ? "overlay" : "hidden";
    return "inline";
  }
  if (pane === "inspector") {
    if (tier === LAYOUT_TIERS.REGULAR) return "inline";
    return overlayOpen ? "overlay" : "hidden";
  }
  throw new Error(`Unknown desktop pane: ${pane}`);
}

export function nextPaneWidth(kind, currentWidth, direction, constraints = DESKTOP_LAYOUT) {
  const delta = direction === "decrease" ? -constraints.keyboardStep : constraints.keyboardStep;
  return clampPaneWidth(kind, Number(currentWidth) + delta, constraints);
}

export function normalizeWindowLayoutPreferences(value, constraints = DESKTOP_LAYOUT) {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.freeze({
    sidebarPreference: candidate.sidebarPreference === "closed" ? "closed" : "open",
    sidebarWidth: clampPaneWidth("sidebar", candidate.sidebarWidth, constraints),
    inspectorPreference: candidate.inspectorPreference === "closed" ? "closed" : "open",
    inspectorWidth: clampPaneWidth("inspector", candidate.inspectorWidth, constraints),
    zoom: normalizeZoom(candidate.zoom)
  });
}

export function normalizeZoom(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return DESKTOP_ZOOM.default;
  const bounded = Math.min(DESKTOP_ZOOM.max, Math.max(DESKTOP_ZOOM.min, numeric));
  return Math.round(bounded * 100) / 100;
}

export function nextZoom(value, direction) {
  const delta = direction === "decrease" ? -DESKTOP_ZOOM.step : DESKTOP_ZOOM.step;
  return normalizeZoom(normalizeZoom(value) + delta);
}
