import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEXT_REVEAL_MAX_LAG_MS,
  DEFAULT_TEXT_REVEAL_TARGET_MS,
  createTextRevealController,
  splitGraphemes,
  textRevealBoundary
} from "./text-reveal.js";

function revealFixture(options = {}) {
  let currentTime = 0;
  let nextFrameId = 1;
  const frames = new Map();
  const revealed = [];
  const controller = createTextRevealController({
    onReveal: (value) => revealed.push(value),
    requestFrame: (callback) => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    now: () => currentTime,
    shouldRevealImmediately: () => Boolean(options.immediate),
    targetMs: DEFAULT_TEXT_REVEAL_TARGET_MS,
    maxLagMs: DEFAULT_TEXT_REVEAL_MAX_LAG_MS
  });
  return {
    controller,
    revealed,
    advanceTo(timestamp) {
      currentTime = timestamp;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(timestamp));
    },
    scheduledFrames: () => frames.size
  };
}

describe("adaptive text reveal", () => {
  it("segments user-perceived graphemes without splitting emoji sequences", () => {
    expect(splitGraphemes("你👨‍👩‍👧‍👦好")).toEqual(["你", "👨‍👩‍👧‍👦", "好"]);
  });

  it("shows the first grapheme immediately and drains the rest with animation frames", () => {
    const fixture = revealFixture();
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "你好，世界"
    });

    expect(fixture.revealed.map((entry) => entry.content).join("")).toBe("你");
    expect(fixture.scheduledFrames()).toBe(1);

    fixture.advanceTo(1600);
    expect(fixture.revealed.map((entry) => entry.content).join("").length).toBeGreaterThan(1);
    fixture.advanceTo(3200);

    expect(fixture.revealed.map((entry) => entry.content).join("")).toBe("你好，世界");
    expect(fixture.controller.hasPending("run-1")).toBe(false);
  });

  it("flushes preceding text synchronously at an interleaved activity boundary", () => {
    const fixture = revealFixture();
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "先解释这一段。"
    });

    expect(fixture.controller.flush("run-1")).toBe(true);
    expect(fixture.revealed.map((entry) => entry.content).join("")).toBe("先解释这一段。");
    expect(fixture.scheduledFrames()).toBe(0);
  });

  it("discards unrevealed text on a content-filter terminal", () => {
    const fixture = revealFixture();
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "只显示首字，其余丢弃"
    });
    fixture.controller.discard("run-1");
    fixture.advanceTo(800);

    expect(fixture.revealed.map((entry) => entry.content).join("")).toBe("只");
    expect(fixture.scheduledFrames()).toBe(0);
  });

  it("bypasses animation for reduced motion or hidden-window rendering", () => {
    const fixture = revealFixture({ immediate: true });
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "立即完整显示"
    });

    expect(fixture.revealed.map((entry) => entry.content).join("")).toBe("立即完整显示");
    expect(fixture.scheduledFrames()).toBe(0);
  });

  it("maps only visible timeline boundaries to flush or discard", () => {
    for (const type of [
      "approval.request",
      "approval.result",
      "tool_call.delta",
      "tool_call.request",
      "skill.activated",
      "skill.invoked",
      "skill.run",
      "turn.failed"
    ]) {
      expect(textRevealBoundary({ type })).toBe("flush");
    }
    expect(textRevealBoundary({ type: "turn.completed", finish_reason: "stop" })).toBe("flush");
    expect(textRevealBoundary({ type: "turn.completed", finish_reason: "content_filter" })).toBe("discard");
    expect(textRevealBoundary({ type: "turn.state" })).toBe("none");
  });
});
