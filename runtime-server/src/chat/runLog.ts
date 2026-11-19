import type { AgentDelta } from "../protocol.js";
import { RunFenced } from "../runHold.js";
import type { RuntimeStore, StoreEventInput } from "../store.js";
import type { RunEventHub } from "./runEventHub.js";

/** Assistant text and thinking reach the log in pieces: after this long, or this many bytes, or before any other event. */
export const RUN_LOG_FLUSH_MS = 250;
export const RUN_LOG_FLUSH_BYTES = 2048;
const WRITE_ATTEMPTS = 3;

type Pending = { kind: "text"; content: string } | { kind: "thinking"; index: number; delta: string };

/**
 * What one execution of a Run writes to the conversation's log. It owns the Run's `run_seq`, so a write that is retried (or
 * made twice by an instance that took the Run over) lands once; it keeps the order of the Run's events; and it tells observers
 * only after the append committed. Text and thinking arrive in small pieces: they are joined before they are written.
 */
export class RunLog {
  private seq = 0;
  private chain: Promise<void> = Promise.resolve();
  private error: unknown;
  private pending: Pending | undefined;
  private timer: NodeJS.Timeout | undefined;

  private constructor(
    private readonly deps: { store: Pick<RuntimeStore, "append" | "maxRunSeq">; hub: Pick<RunEventHub, "advanced">; conversationId: string; runId: string; flushMs?: number; flushBytes?: number }
  ) {}

  /** Continues the Run's own sequence, so an instance that takes the Run over does not repeat a number. */
  static async open(deps: { store: Pick<RuntimeStore, "append" | "maxRunSeq">; hub: Pick<RunEventHub, "advanced">; conversationId: string; runId: string; flushMs?: number; flushBytes?: number }): Promise<RunLog> {
    const log = new RunLog(deps);
    log.seq = await deps.store.maxRunSeq(deps.runId);
    return log;
  }

  /** Text the guard released. */
  text(content: string): void {
    if (this.pending && this.pending.kind !== "text") this.cut();
    this.accumulate({ kind: "text", content }, content);
  }

  /** A thinking block's start, delta or end, as the model yields it. */
  thinking(delta: Exclude<AgentDelta["delta"], { kind: "text" | "status" }>): Promise<void> | void {
    if (delta.kind === "thinking_delta") {
      if (this.pending && (this.pending.kind !== "thinking" || this.pending.index !== delta.contentIndex)) this.cut();
      this.accumulate({ kind: "thinking", index: delta.contentIndex, delta: delta.delta }, delta.delta);
      return;
    }
    return this.append(delta.kind === "thinking_start"
      ? { type: "assistant.thinking", conversation_id: this.deps.conversationId, run_id: this.deps.runId, index: delta.contentIndex, phase: "start" }
      : { type: "assistant.thinking", conversation_id: this.deps.conversationId, run_id: this.deps.runId, index: delta.contentIndex, phase: "end", content: delta.content });
  }

  /** Any other event of this Run: what was joined so far goes first, so the log keeps the order the Run had. */
  append(event: StoreEventInput): Promise<void> {
    this.cut();
    return this.write(event);
  }

  /** Everything accepted so far is in the log, or this throws what stopped it. */
  async flush(): Promise<void> {
    this.cut();
    await this.chain;
    if (this.error) throw this.error;
  }

  private accumulate(next: Pending, piece: string): void {
    if (!this.pending) this.pending = next;
    else if (this.pending.kind === "text" && next.kind === "text") this.pending.content += piece;
    else if (this.pending.kind === "thinking" && next.kind === "thinking") this.pending.delta += piece;
    const size = this.pending.kind === "text" ? this.pending.content.length : this.pending.delta.length;
    if (size >= (this.deps.flushBytes ?? RUN_LOG_FLUSH_BYTES)) this.cut();
    else if (!this.timer) { this.timer = setTimeout(() => this.cut(), this.deps.flushMs ?? RUN_LOG_FLUSH_MS); this.timer.unref(); }
  }

  /** Writes what is joined, in the background; a failure is kept and thrown by the next append or flush. */
  private cut(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    const { conversationId, runId } = this.deps;
    void this.write(pending.kind === "text"
      ? { type: "assistant.text", conversation_id: conversationId, run_id: runId, content: pending.content }
      : { type: "assistant.thinking", conversation_id: conversationId, run_id: runId, index: pending.index, phase: "delta", delta: pending.delta }).catch(() => undefined);
  }

  private write(event: StoreEventInput): Promise<void> {
    const run_seq = ++this.seq;
    const done = this.chain.then(async () => {
      if (this.error) throw this.error;
      await this.commit({ ...event, run_seq } as StoreEventInput);
    });
    this.chain = done.catch((error: unknown) => { this.error ??= error; });
    return done;
  }

  /** The same `run_seq` on every attempt: an attempt that did commit before it failed is not written twice. */
  private async commit(event: StoreEventInput): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const position = await this.deps.store.append(event);
        this.deps.hub.advanced(this.deps.conversationId, position as unknown as number);
        return;
      } catch (error) {
        if (error instanceof RunFenced || attempt >= WRITE_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
      }
    }
  }
}

/**
 * The store as one execution of a Run sees it: whatever that Run appends goes through its RunLog, so every writer of the Run
 * (tools, the broker, the transcript) shares one order and one `run_seq`. Everything else passes through.
 */
export function throughLog<T extends Pick<RuntimeStore, "append">>(store: T, log: RunLog, runId: string): T {
  return new Proxy(store, {
    get(target, key) {
      if (key === "append") return (event: StoreEventInput, ...rest: unknown[]) => (event as { run_id?: string }).run_id === runId ? log.append(event) : (target.append as (...args: unknown[]) => unknown)(event, ...rest);
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
