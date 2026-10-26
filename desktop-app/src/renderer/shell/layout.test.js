import { describe, expect, it } from "vitest";
import {
  DESKTOP_LAYOUT,
  DESKTOP_ZOOM,
  LAYOUT_TIERS,
  clampPaneWidth,
  layoutThresholds,
  layoutTierForWidth,
  nextPaneWidth,
  normalizeWindowLayoutPreferences,
  nextZoom,
  normalizeZoom,
  panePresentation,
  resetPaneWidth
} from "./desktop-layout.js";

describe("desktop window layout", () => {
  it("derives regular, compact, and minimal tiers from pane constraints", () => {
    const thresholds = layoutThresholds();

    expect(layoutTierForWidth(thresholds.regular + 1)).toBe(LAYOUT_TIERS.REGULAR);
    expect(layoutTierForWidth(thresholds.compact + 1)).toBe(LAYOUT_TIERS.COMPACT);
    expect(layoutTierForWidth(thresholds.compact - 1)).toBe(LAYOUT_TIERS.MINIMAL);
  });

  it("uses hysteresis so a live resize cannot flicker around a boundary", () => {
    const { compact, regular } = layoutThresholds();

    expect(layoutTierForWidth(regular - 1, LAYOUT_TIERS.REGULAR)).toBe(LAYOUT_TIERS.REGULAR);
    expect(layoutTierForWidth(regular - DESKTOP_LAYOUT.hysteresis - 1, LAYOUT_TIERS.REGULAR)).toBe(LAYOUT_TIERS.COMPACT);
    expect(layoutTierForWidth(compact + 1, LAYOUT_TIERS.MINIMAL)).toBe(LAYOUT_TIERS.MINIMAL);
    expect(layoutTierForWidth(compact + DESKTOP_LAYOUT.hysteresis + 1, LAYOUT_TIERS.MINIMAL)).toBe(LAYOUT_TIERS.COMPACT);
  });

  it("preserves preference while converting space-constrained panes to overlays", () => {
    expect(panePresentation({ tier: "regular", pane: "sidebar" })).toBe("inline");
    expect(panePresentation({ tier: "compact", pane: "inspector" })).toBe("hidden");
    expect(panePresentation({ tier: "compact", pane: "inspector", overlayOpen: true })).toBe("overlay");
    expect(panePresentation({ tier: "minimal", pane: "sidebar", overlayOpen: true })).toBe("overlay");
    expect(panePresentation({ tier: "minimal", pane: "sidebar", preference: "closed", overlayOpen: true })).toBe("hidden");
  });

  it("clamps and resets pane dimensions for pointer and keyboard splitters", () => {
    expect(clampPaneWidth("sidebar", -10)).toBe(DESKTOP_LAYOUT.sidebar.min);
    expect(clampPaneWidth("inspector", 10_000)).toBe(DESKTOP_LAYOUT.inspector.max);
    expect(nextPaneWidth("sidebar", DESKTOP_LAYOUT.sidebar.min, "decrease")).toBe(DESKTOP_LAYOUT.sidebar.min);
    expect(nextPaneWidth("inspector", 300, "increase")).toBe(316);
    expect(resetPaneWidth("sidebar")).toBe(DESKTOP_LAYOUT.sidebar.default);
  });

  it("normalizes only durable per-window preferences and keeps zoom bounded", () => {
    expect(normalizeWindowLayoutPreferences({
      sidebarPreference: "closed",
      sidebarWidth: 999,
      inspectorWidth: 100,
      zoom: 7
    })).toEqual({
      sidebarPreference: "closed",
      sidebarWidth: DESKTOP_LAYOUT.sidebar.max,
      inspectorPreference: "open",
      inspectorWidth: DESKTOP_LAYOUT.inspector.min,
      zoom: 2
    });
  });

  it("keeps application zoom independent, bounded, and keyboard-steppable", () => {
    expect(normalizeZoom(undefined)).toBe(DESKTOP_ZOOM.default);
    expect(normalizeZoom(0.1)).toBe(DESKTOP_ZOOM.min);
    expect(normalizeZoom(4)).toBe(DESKTOP_ZOOM.max);
    expect(nextZoom(1, "decrease")).toBe(0.9);
    expect(nextZoom(DESKTOP_ZOOM.min, "decrease")).toBe(DESKTOP_ZOOM.min);
    expect(nextZoom(DESKTOP_ZOOM.max, "increase")).toBe(DESKTOP_ZOOM.max);
  });
});
