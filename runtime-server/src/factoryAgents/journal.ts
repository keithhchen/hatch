export type JournalEvent = { sessionId: string; type: string; [key: string]: unknown };

/**
 * Where a runtime writes what happens, from its first Run on, whether or not anyone is watching.
 * Calls are kept in order, so the record is the order things happened in.
 */
export interface Journal {
  /** Records the event. Never throws and never makes the runtime wait. */
  append(event: JournalEvent): void;
  /** Records the event and runs `persist` as one step: a reader that sees one sees the other. When `persist` throws, nothing is recorded. */
  commit(event: JournalEvent, persist: () => Promise<unknown>): Promise<void>;
}
