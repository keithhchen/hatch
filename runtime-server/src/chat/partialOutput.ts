/** Runs `action` with the latest value at most once per `everyMs`; `flush` writes whatever is pending. */
export function throttled<T>(everyMs: number, action: (value: T) => Promise<void>, now: () => number = Date.now) {
  let lastAt = Number.NEGATIVE_INFINITY;
  let pending: { value: T } | undefined;
  let inflight: Promise<void> = Promise.resolve();
  const run = (value: T): void => {
    pending = undefined;
    lastAt = now();
    inflight = inflight.then(() => action(value)).catch(() => undefined);
  };
  return {
    push(value: T): void {
      if (now() - lastAt >= everyMs) run(value);
      else pending = { value };
    },
    async flush(): Promise<void> {
      if (pending) run(pending.value);
      await inflight;
    }
  };
}

type Publish = (message: Record<string, unknown>) => void;

/**
 * Wraps a publisher so the text a Run has produced so far is saved now and then.
 * A client that comes back reads it from the snapshot instead of finding nothing.
 */
export function withPartialOutput(publish: Publish, save: (text: string) => Promise<void>, everyMs = 1000) {
  let text = "";
  const saver = throttled(everyMs, save);
  return {
    publish: ((message) => {
      const delta = message.type === "assistant.delta" ? message.delta as { kind?: string; content?: string } : undefined;
      if (delta?.kind === "text" && typeof delta.content === "string") {
        // The offset places the delta in the Run's text, so any client joins it to a snapshot or a replay exactly.
        const offset = text.length;
        text += delta.content;
        saver.push(text);
        return publish({ ...message, delta: { ...delta, offset } });
      }
      publish(message);
    }) as Publish,
    flush: () => saver.flush()
  };
}
