export function projectApprovedRuntimeStream(activeRun, message, now = Date.now()) {
  if (!activeRun || (message?.run_id && message.run_id !== activeRun.runId)) return null;

  if (message.type === "assistant.delta" && message.delta?.kind === "text") {
    const timestamp = now;
    return {
      type: "append",
      activeRun: {
        ...activeRun,
        text: `${activeRun.text ?? ""}${message.delta.content ?? ""}`,
        timing: {
          ...(activeRun.timing ?? {}),
          firstSafeDeltaReceivedAt: activeRun.timing?.firstSafeDeltaReceivedAt ?? timestamp,
          firstTextUpdateQueuedAt: activeRun.timing?.firstTextUpdateQueuedAt ?? timestamp
        }
      },
      assistantId: activeRun.assistantId,
      content: message.delta.content ?? ""
    };
  }

  if (message.type === "turn.completed") {
    const timestamp = now;
    const nextRun = {
      ...activeRun,
      timing: {
        ...(activeRun.timing ?? {}),
        turnCompletedReceivedAt: timestamp,
        server: message.timing
      }
    };
    return {
      type: "finalize",
      activeRun: nextRun,
      assistantId: nextRun.assistantId,
      runId: nextRun.runId,
      text: nextRun.text || "Done.",
      finishReason: message.finish_reason,
      completedAt: timestamp
    };
  }

  return null;
}

export function summarizeTurnTiming(runId, timing, fullResponseAt, measuredAt = Date.now()) {
  const sinceQuestion = (timestamp) => timestamp === undefined
    ? undefined
    : timestamp - timing.questionSentAt;
  return {
    run_id: runId,
    measured_at: new Date(measuredAt).toISOString(),
    client_ms: {
      question_to_first_safe_delta: sinceQuestion(timing.firstSafeDeltaReceivedAt),
      question_to_first_text_update_queued: sinceQuestion(timing.firstTextUpdateQueuedAt),
      question_to_turn_completed: sinceQuestion(timing.turnCompletedReceivedAt),
      question_to_full_response: sinceQuestion(fullResponseAt)
    },
    server_ms: timing.server
  };
}
