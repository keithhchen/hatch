import type { ConversationRunRecord } from "../conversationRepository.js";
import type { VisibleConversationMessage } from "../store.js";

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);

/**
 * Waits for a Run to end by looking at the durable record, so it works for a Run
 * that another instance executes. Undefined means it was still going when time ran out.
 */
export async function waitForTerminalRun(
  getRun: () => Promise<ConversationRunRecord | undefined>,
  timeoutMs: number,
  pollMs = 100,
  signal?: AbortSignal
): Promise<ConversationRunRecord | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const run = await getRun();
    if (!run || TERMINAL_STATUSES.has(run.status)) return run;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

/** One reply per Run: the last thing the assistant said in it. */
export const finalAssistantText = (history: readonly VisibleConversationMessage[], runId: string): string =>
  history.filter((message) => message.role === "assistant" && message.run_id === runId).at(-1)?.content ?? "";
