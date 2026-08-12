import { describe, expect, it } from "vitest";
import { clampWindowFrame, normalizeWindowFrame } from "./desktop-window-frame.js";

const monitor = {
  workArea: {
    position: { x: 0, y: 0 },
    size: { width: 1920, height: 1080 }
  }
};

describe("desktop window frame", () => {
  it("rejects malformed geometry and applies minimum dimensions", () => {
    expect(normalizeWindowFrame(null)).toBeNull();
    expect(normalizeWindowFrame({ x: 10, y: 20, width: 10, height: 20 })).toEqual({
      x: 10, y: 20, width: 640, height: 600
    });
  });

  it("clamps a disconnected/off-screen frame into a monitor work area", () => {
    expect(clampWindowFrame({ x: 5000, y: -900, width: 1400, height: 900 }, [monitor])).toEqual({
      x: 520, y: 0, width: 1400, height: 900
    });
  });

  it("uses the first available monitor when no saved frame is visible", () => {
    expect(clampWindowFrame({ x: -5000, y: -5000, width: 900, height: 700 }, [monitor])).toEqual({
      x: 0, y: 0, width: 900, height: 700
    });
  });
});

