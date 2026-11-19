import { reported } from "../observability/reported.js";
import type { ConversationJournalEvent, ConversationJournalPage } from "../conversationRepository.js";
import { publicJournalPayload } from "./messageLedger.js";
import type { PublicLogEvent, RuntimeStore } from "../store.js";
import { LogTail } from "./logTail.js";
import type { EventSink, RunEventHub } from "./runEventHub.js";

export interface JournalSource {
  journalPage(conversationId: string, afterCursor: number, throughCursor?: number, limit?: number): Promise<ConversationJournalPage>;
}

/** One event shape in every transport: the journal entry with its cursor. */
export const journalEnvelope = (event: ConversationJournalEvent): Record<string, unknown> => ({
  type: "journal.event",
  cursor: event.cursor,
  journal_type: event.type,
  ...(event.runId ? { run_id: event.runId } : {}),
  payload: publicJournalPayload(event.payload),
  created_at: event.createdAt
});

export type FeedOptions = {
  /** Resume point: the cursor of a snapshot or of the last event received. */
  afterCursor: number;
  /** Also receive what the Run says as it goes (its text, its tool calls), not only its durable events. */
  stream: boolean;
};

/**
 * The public REST API's view of a conversation: durable events from the journal by cursor, and, when the client wants to
 * stream, the Run's words and tool calls as they enter the conversation's log (`assistant.delta`, `tool_call.delta`).
 */
export class ConversationFeed {
  constructor(
    private readonly source: JournalSource,
    private readonly hub: Pick<RunEventHub, "subscribe">,
    private readonly pollMs = 200,
    private readonly log?: Pick<RuntimeStore, "readLogPage" | "readLogTurns" | "logHead">
  ) {}

  attach(conversationId: string, options: FeedOptions, sink: EventSink): () => void {
    let cursor = options.afterCursor;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let lastFailure: string | undefined;
    let lastFailureAt = 0;
    let stopTail = (): void => undefined;
    const drop = (): void => { stopped = true; clearTimeout(timer); stopTail(); };
    const guarded = (event: Record<string, unknown>): void => {
      try { sink.push(event); } catch { drop(); }
    };
    if (options.stream && this.log) void this.follow(conversationId, guarded).then((stop) => { if (stopped) stop(); else stopTail = stop; });
    const poll = async (): Promise<void> => {
      try {
        for (;;) {
          const page = await this.source.journalPage(conversationId, cursor, undefined, 100);
          for (const event of page.events) guarded(journalEnvelope(event));
          cursor = page.cursor;
          if (!page.has_more || stopped) break;
        }
      } catch (error) {
        // The next poll retries; the same failure is logged once a minute, not every poll.
        const message = error instanceof Error ? error.message : String(error);
        if (message !== lastFailure || Date.now() - lastFailureAt > 60_000) { reported("conversation_feed_poll_failed", { conversation_id: conversationId })(error); lastFailure = message; lastFailureAt = Date.now(); }
      }
      if (!stopped) timer = setTimeout(() => void poll(), this.pollMs);
    };
    void poll();
    return drop;
  }

  /** The words and tool calls of the conversation's latest turn so far, then as they come, in the shapes the REST streams have always carried. */
  private async follow(conversationId: string, push: (event: Record<string, unknown>) => void): Promise<() => void> {
    const log = this.log!;
    const sent = new Map<string, number>();
    const translate = (event: PublicLogEvent): void => {
      const e = event as unknown as Record<string, unknown>;
      if (e.type === "assistant.text" && typeof e.content === "string") {
        const runId = String(e.run_id);
        const offset = sent.get(runId) ?? 0;
        sent.set(runId, offset + e.content.length);
        push({ type: "assistant.delta", run_id: e.run_id, delta: { kind: "text", content: e.content, offset } });
      } else if (e.type === "tool.call") {
        push({ ...e, type: "tool_call.delta" });
        if (e.locality === "client" && e.status === "requested" && e.approval === "ask") push({ ...e, type: "tool_call.request" });
      }
    };
    const { events, head } = await log.readLogTurns(conversationId, { turns: 1 });
    for (const event of events) translate(event);
    return new LogTail({ source: log, hub: this.hub }).attach(conversationId, head, { push: (event) => translate(event as unknown as PublicLogEvent) });
  }
}
