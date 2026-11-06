import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TEXT_REVEAL_MAX_LAG_MS,
  DEFAULT_TEXT_REVEAL_TARGET_MS,
  createTextRevealController,
  splitGraphemes,
  textRevealBoundary
} from "../src/domain/text-reveal.js";

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
    assert.deepEqual(splitGraphemes("你👨‍👩‍👧‍👦好"), ["你", "👨‍👩‍👧‍👦", "好"]);
  });

  it("shows the first grapheme immediately and drains the rest with animation frames", () => {
    const fixture = revealFixture();
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "你好，世界"
    });

    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "你");
    assert.equal(fixture.scheduledFrames(), 1);

    fixture.advanceTo(1600);
    assert.ok(fixture.revealed.map((entry) => entry.content).join("").length > 1);
    fixture.advanceTo(3200);

    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "你好，世界");
    assert.equal(fixture.controller.hasPending("run-1"), false);
  });

  it("flushes preceding text synchronously at an interleaved activity boundary", () => {
    const fixture = revealFixture();
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "先解释这一段。"
    });

    assert.equal(fixture.controller.flush("run-1"), true);
    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "先解释这一段。");
    assert.equal(fixture.scheduledFrames(), 0);
  });

  it("drains a completed turn at the reveal pace before settling it", () => {
    const fixture = revealFixture();
    let settled = false;
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "最后一段不能突然全部出现"
    });

    assert.equal(fixture.controller.complete("run-1", () => { settled = true; }), true);
    assert.equal(settled, false);
    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "最");

    fixture.advanceTo(1600);
    assert.equal(settled, false);
    assert.equal(fixture.controller.hasPending("run-1"), true);
    fixture.advanceTo(3200);

    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "最后一段不能突然全部出现");
    assert.equal(settled, true);
    assert.equal(fixture.controller.hasPending("run-1"), false);
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

    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "只");
    assert.equal(fixture.scheduledFrames(), 0);
  });

  it("bypasses animation for reduced motion or hidden-window rendering", () => {
    const fixture = revealFixture({ immediate: true });
    fixture.controller.enqueue({
      runId: "run-1",
      assistantId: "assistant-1",
      content: "立即完整显示"
    });

    assert.equal(fixture.revealed.map((entry) => entry.content).join(""), "立即完整显示");
    assert.equal(fixture.scheduledFrames(), 0);
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
      assert.equal(textRevealBoundary({ type }), "flush");
    }
    assert.equal(textRevealBoundary({ type: "turn.completed", finish_reason: "stop" }), "drain");
    assert.equal(textRevealBoundary({ type: "turn.completed", finish_reason: "content_filter" }), "discard");
    assert.equal(textRevealBoundary({ type: "turn.state" }), "none");
  });
});
