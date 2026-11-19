import type { ConversationEvent, Unsubscribe } from "../conversations/conversation.js";
import type { EventLog, LoggedEvent } from "../conversations/eventLog.js";
import type { ConversationRepository } from "../conversationRepository.js";
import type { RunEventHub } from "../chat/runEventHub.js";
import type { EventCursor } from "../surfaces/contract.js";
import { conversationOfFeedKey, studioVocabulary } from "./studioVocabulary.js";

/**
 * The Assistant's events for Studio observers, read from Chat's own record: the conversation's journal, in Studio's
 * words. The cursor is the journal's cursor, so a client resumes by it after any break and finds every event once.
 * Nothing is copied into a second log; a feed that is asked to append refuses, because the Run's journal is the record.
 * Text, thinking and steps are rows of the conversation's event log, which the Studio page reads by position; this feed only wakes it.
 */
export class JournalFeed implements EventLog {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "journalPage" | "journalHead">;
    hub: Pick<RunEventHub, "subscribe">;
  }) {}

  private conversation(key: string): string {
    const id = conversationOfFeedKey(key);
    if (!id) throw new Error(`${key} is not a feed of the Assistant`);
    return id;
  }

  async append(): Promise<never> { throw new Error("The Assistant's events are its Run's journal; nothing appends to them."); }
  async commit(): Promise<never> { throw new Error("The Assistant's events are its Run's journal; nothing appends to them."); }

  async head(key: string): Promise<EventCursor> { return String(await this.deps.repository.journalHead(this.conversation(key))); }

  async after(key: string, cursor: EventCursor, limit = 500): Promise<LoggedEvent[]> {
    const conversation = this.conversation(key);
    if (await this.deps.repository.journalHead(conversation) <= Number(cursor)) return [];
    const { events } = await this.deps.repository.journalPage(conversation, Number(cursor), undefined, limit);
    return events.flatMap(event => studioVocabulary({ journal: event }).map(shown => ({ cursor: String(event.cursor), event: shown })));
  }

  /** The head is read before anything else: a message is in what the reader then reads or in the events after the head, possibly both, and the ids tell which. */
  consistent<T>(key: string, read: (head: EventCursor) => Promise<T>): Promise<T> { return this.head(key).then(read); }

  onAppend(key: string, wake: () => void): Unsubscribe {
    return this.deps.hub.subscribe(this.conversation(key), () => wake());
  }
}
