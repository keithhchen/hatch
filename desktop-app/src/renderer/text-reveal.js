export const DEFAULT_TEXT_REVEAL_TARGET_MS = 3200;
export const DEFAULT_TEXT_REVEAL_MAX_LAG_MS = 4800;

const TEXT_REVEAL_FLUSH_EVENTS = new Set([
  "approval.request",
  "approval.result",
  "tool_call.delta",
  "tool_call.request",
  "turn.failed"
]);

export function textRevealBoundary(message) {
  if (message?.type === "turn.completed") {
    return message.finish_reason === "content_filter" ? "discard" : "drain";
  }
  return TEXT_REVEAL_FLUSH_EVENTS.has(message?.type) ? "flush" : "none";
}

export function splitGraphemes(text) {
  const value = String(text ?? "");
  if (!value) return [];
  if (typeof Intl?.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return [...segmenter.segment(value)].map((entry) => entry.segment);
  }
  return Array.from(value);
}

export function createTextRevealController({
  onReveal,
  requestFrame = (callback) => globalThis.requestAnimationFrame(callback),
  cancelFrame = (frameId) => globalThis.cancelAnimationFrame(frameId),
  now = () => globalThis.performance.now(),
  shouldRevealImmediately = () => false,
  targetMs = DEFAULT_TEXT_REVEAL_TARGET_MS,
  maxLagMs = DEFAULT_TEXT_REVEAL_MAX_LAG_MS
}) {
  if (typeof onReveal !== "function") throw new TypeError("onReveal is required");
  if (!(targetMs > 0) || !(maxLagMs >= targetMs)) {
    throw new RangeError("Text reveal timing must satisfy 0 < targetMs <= maxLagMs");
  }

  let stream = null;
  let frameId = null;
  let lastFrameAt = 0;
  let oldestQueuedAt = 0;
  let deadlineAt = 0;

  const cancelScheduledFrame = () => {
    if (frameId === null) return;
    cancelFrame(frameId);
    frameId = null;
  };

  const clearQueue = () => {
    if (stream) stream.pending = [];
    oldestQueuedAt = 0;
    deadlineAt = 0;
    lastFrameAt = 0;
  };

  const settleDrainedStream = () => {
    if (!stream || stream.pending.length > 0) return false;
    const onDrained = stream.onDrained;
    stream.onDrained = null;
    clearQueue();
    onDrained?.();
    return true;
  };

  const reveal = (graphemes) => {
    if (!stream || graphemes.length === 0) return;
    onReveal({
      runId: stream.runId,
      assistantId: stream.assistantId,
      content: graphemes.join("")
    });
  };

  const schedule = () => {
    if (frameId !== null || !stream?.pending.length) return;
    frameId = requestFrame(tick);
  };

  const tick = (timestamp) => {
    frameId = null;
    if (!stream?.pending.length) return;
    if (shouldRevealImmediately()) {
      flush(stream.runId);
      return;
    }

    const current = Number.isFinite(timestamp) ? timestamp : now();
    const frameElapsed = Math.max(1, Math.min(50, current - (lastFrameAt || current - 16)));
    const remainingMs = Math.max(frameElapsed, deadlineAt - current);
    const count = Math.max(1, Math.ceil(stream.pending.length * frameElapsed / remainingMs));
    reveal(stream.pending.splice(0, count));
    lastFrameAt = current;

    if (stream.pending.length === 0) {
      settleDrainedStream();
      return;
    }
    schedule();
  };

  const flush = (runId) => {
    if (!stream || (runId && stream.runId !== runId)) return false;
    cancelScheduledFrame();
    reveal(stream.pending.splice(0));
    settleDrainedStream();
    return true;
  };

  const complete = (runId, onDrained) => {
    if (typeof onDrained !== "function") throw new TypeError("onDrained is required");
    if (!stream || (runId && stream.runId !== runId)) {
      onDrained();
      return false;
    }
    stream.onDrained = onDrained;
    if (!settleDrainedStream()) schedule();
    return true;
  };

  const discard = (runId) => {
    if (!stream || (runId && stream.runId !== runId)) return false;
    cancelScheduledFrame();
    stream.onDrained = null;
    clearQueue();
    if (!runId || stream.runId === runId) stream = null;
    return true;
  };

  const enqueue = ({ runId, assistantId, content }) => {
    const graphemes = splitGraphemes(content);
    if (!runId || !assistantId || graphemes.length === 0) return;

    if (stream && (stream.runId !== runId || stream.assistantId !== assistantId)) {
      flush();
      stream = null;
    }
    stream ??= { runId, assistantId, pending: [], onDrained: null };

    if (shouldRevealImmediately()) {
      reveal(graphemes);
      return;
    }

    const queuedAt = now();
    if (stream.pending.length === 0) {
      oldestQueuedAt = queuedAt;
      lastFrameAt = queuedAt;
      reveal(graphemes.splice(0, 1));
    }
    stream.pending.push(...graphemes);
    deadlineAt = Math.min(oldestQueuedAt + maxLagMs, queuedAt + targetMs);
    schedule();
  };

  return {
    enqueue,
    complete,
    flush,
    discard,
    hasPending: (runId) => Boolean(
      stream?.pending.length && (!runId || stream.runId === runId)
    )
  };
}
