import type { ConversationJournalEvent, ConversationJournalPage } from "../conversationRepository.js";
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
  payload: event.payload,
  created_at: event.createdAt
});

export type FeedOptions = {
  /** Resume point: the cursor of a snapshot or of the last event received. */
  afterCursor: number;
  /** Also receive the live deltas of the Run, not only its durable events. */
  stream: boolean;
};

/**
 * Observes a conversation. Durable events come from the journal by cursor, so
 * they reach any client whichever instance runs the Run and survive a restart;
 * live deltas come from the hub when the client wants to stream.
 */
export class ConversationFeed {
  constructor(
    private readonly source: JournalSource,
    private readonly hub: RunEventHub,
    private readonly pollMs = 200
  ) {}

  attach(conversationId: string, options: FeedOptions, sink: EventSink): () => void {
    let cursor = options.afterCursor;
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    const drop = (): void => { stopped = true; clearTimeout(timer); unsubscribe(); };
    const guarded = (event: Record<string, unknown>): void => {
      try { sink.push(event); } catch { drop(); }
    };
    const unsubscribe = options.stream ? this.hub.subscribe(conversationId, { push: guarded }) : () => undefined;
    // Subscribing and catching up are one step, so the text is neither cut nor repeated.
    const caughtUp = options.stream ? this.hub.catchUp(conversationId) : undefined;
    if (caughtUp) guarded(caughtUp);
    const poll = async (): Promise<void> => {
      try {
        for (;;) {
          const page = await this.source.journalPage(conversationId, cursor, undefined, 100);
          for (const event of page.events) guarded(journalEnvelope(event));
          cursor = page.cursor;
          if (!page.has_more || stopped) break;
        }
      } catch { /* the next poll retries; a vanished conversation simply yields nothing */ }
      if (!stopped) timer = setTimeout(() => void poll(), this.pollMs);
    };
    void poll();
    return drop;
  }
}
