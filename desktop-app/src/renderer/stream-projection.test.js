import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { projectApprovedRuntimeStream, summarizeTurnTiming } from "./stream-projection.js";

describe("approved runtime stream projection", () => {
  it("projects an approved text delta synchronously without a paint or queue abstraction", async () => {
    const activeRun = {
      runId: "run_1",
      assistantId: "assistant_1",
      text: "Hello",
      timing: { questionSentAt: 100 }
    };

    const projection = projectApprovedRuntimeStream(activeRun, {
      type: "assistant.delta",
      run_id: "run_1",
      delta: { kind: "text", content: " world" }
    }, 125);

    expect(projection).toMatchObject({
      type: "append",
      assistantId: "assistant_1",
      content: " world",
      activeRun: {
        text: "Hello world",
        timing: { firstSafeDeltaReceivedAt: 125, firstTextUpdateQueuedAt: 125 }
      }
    });
    const source = await readFile(new URL("./stream-projection.js", import.meta.url), "utf8");
    expect(source).not.toMatch(/requestAnimationFrame|queueMicrotask|setTimeout/);
  });

  it("finalizes turn.completed in the same reducer step", () => {
    const projection = projectApprovedRuntimeStream({
      runId: "run_1",
      assistantId: "assistant_1",
      text: "Complete answer",
      timing: { questionSentAt: 100, firstTextUpdateQueuedAt: 125 }
    }, {
      type: "turn.completed",
      run_id: "run_1",
      finish_reason: "stop",
      timing: { model_ms: 30 }
    }, 160);

    expect(projection).toEqual({
      type: "finalize",
      activeRun: {
        runId: "run_1",
        assistantId: "assistant_1",
        text: "Complete answer",
        timing: {
          questionSentAt: 100,
          firstTextUpdateQueuedAt: 125,
          turnCompletedReceivedAt: 160,
          server: { model_ms: 30 }
        }
      },
      assistantId: "assistant_1",
      runId: "run_1",
      text: "Complete answer",
      finishReason: "stop",
      completedAt: 160
    });
  });

  it("reports honest update-queued timing and never emits the former paint metric", () => {
    const summary = summarizeTurnTiming("run_1", {
      questionSentAt: 100,
      firstSafeDeltaReceivedAt: 120,
      firstTextUpdateQueuedAt: 125,
      turnCompletedReceivedAt: 160,
      server: { model_ms: 30 }
    }, 165, 170);

    expect(summary.client_ms).toEqual({
      question_to_first_safe_delta: 20,
      question_to_first_text_update_queued: 25,
      question_to_turn_completed: 60,
      question_to_full_response: 65
    });
    expect(summary.client_ms).not.toHaveProperty("question_to_first_text_paint");
  });
});
