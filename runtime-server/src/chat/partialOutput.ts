import type { RunPartial } from "../conversationRepository.js";
import { VisibleParts } from "./visibleParts.js";

/** Runs `action` with the latest value at most once per `everyMs`; what arrives inside the interval is run when it ends, and `flush` writes whatever is pending now. */
export function throttled<T>(everyMs: number, action: (value: T) => Promise<void>, now: () => number = Date.now) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const run = (value: T): void => {
    pending = undefined;
    lastAt = now();
    inflight = inflight.then(() => action(value)).catch(() => undefined);
  };
  const cancelTimer = (): void => { clearTimeout(timer); timer = undefined; };
  return {
    /** Saves now, whatever the interval says: for the moments the order of what was shown changes. */
    pushNow(value: T): void { cancelTimer(); run(value); },
    push(value: T): void {
      if (now() - lastAt >= everyMs) { cancelTimer(); run(value); return; }
      pending = { value };
      // The last value of a burst is saved too, not left until the Run ends.
      timer ??= setTimeout(() => { timer = undefined; if (pending) run(pending.value); }, Math.max(0, everyMs - (now() - lastAt)));
      timer.unref();
    },
    async flush(): Promise<void> {
      cancelTimer();
      if (pending) run(pending.value);
      await inflight;
    }
  };
}

type Publish = (message: Record<string, unknown>) => void;

const PROGRESS_EVENTS = new Set(["assistant.delta", "tool_call.delta", "skill.activated", "skill.invoked", "skill.run"]);

/**
 * Wraps a publisher so what the Run has produced so far, its text and the ordered parts around it, is saved now and then.
 * A client that comes back, or a Run that is interrupted, keeps it instead of finding nothing.
 */
export function withPartialOutput(publish: Publish, save: (partial: RunPartial) => Promise<void>, everyMs = 1000) {
  let text = "";
  const visible = new VisibleParts();
  // Read when it is written: a copy per event would cost more than the one write per interval.
  const saver = throttled<() => RunPartial>(everyMs, (read) => save(read()));
  const progress = (): RunPartial => ({ text, parts: structuredClone(visible.parts) });
  return {
    publish: ((message) => {
      const delta = message.type === "assistant.delta" ? message.delta as { kind?: string; content?: string } : undefined;
      // A step the parts cannot take (a thinking delta with no start) never stops the Run; the saved reply is then only less ordered.
      if (PROGRESS_EVENTS.has(String(message.type)) && delta?.kind !== "status") {
        try { visible.accept(message as never); } catch { /* the parts keep what they hold */ }
      }
      if (delta?.kind === "text" && typeof delta.content === "string") {
        // The offset places the delta in the Run's text, so any client joins it to a snapshot or a replay exactly.
        const offset = text.length;
        text += delta.content;
        saver.push(progress);
        return publish({ ...message, delta: { ...delta, offset } });
      }
      // A step beginning or ending fixes the order of what came before it: saved at once, so an interrupted Run keeps it exactly.
      if (PROGRESS_EVENTS.has(String(message.type))) (delta ? saver.push : saver.pushNow)(progress);
      publish(message);
    }) as Publish,
    flush: () => saver.flush()
  };
}
