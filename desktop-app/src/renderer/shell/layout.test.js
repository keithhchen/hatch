import { describe, expect, it } from "vitest";
import { DESKTOP_ZOOM, nextZoom, normalizeZoom } from "./layout.js";

describe("Desktop application zoom", () => {
  it("is bounded and steps in tenths", () => {
    expect(normalizeZoom("nope")).toBe(DESKTOP_ZOOM.default);
    expect(normalizeZoom(4)).toBe(DESKTOP_ZOOM.max);
    expect(normalizeZoom(0.1)).toBe(DESKTOP_ZOOM.min);
    expect(nextZoom(1, "increase")).toBe(1.1);
    expect(nextZoom(1, "decrease")).toBe(0.9);
    expect(nextZoom(DESKTOP_ZOOM.max, "increase")).toBe(DESKTOP_ZOOM.max);
  });
});
