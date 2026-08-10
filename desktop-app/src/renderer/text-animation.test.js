import { describe, expect, it } from "vitest";
import { assistantAnimationChunkSize, takeAssistantAnimationChunk } from "./text-animation.js";

describe("guarded segment text animation", () => {
  it("reveals ordinary segments in small frame-sized chunks", () => {
    expect(assistantAnimationChunkSize(100)).toBe(4);
    expect(assistantAnimationChunkSize(250)).toBe(8);
  });

  it("accelerates when several guarded segments accumulate", () => {
    expect(assistantAnimationChunkSize(750)).toBe(24);
    expect(assistantAnimationChunkSize(1_501)).toBe(64);
  });

  it("does not split Unicode code points", () => {
    expect(takeAssistantAnimationChunk("你😀好呀继续")).toEqual({
      chunk: "你😀好呀",
      remaining: "继续"
    });
  });
});
