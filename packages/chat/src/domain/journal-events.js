/**
 * Every event type the Runtime's conversation journal records. The server's union
 * (`ConversationJournalEvent["type"]` in runtime-server) is checked against this list by a server test,
 * so a type added there fails until it is known here.
 */
export const JOURNAL_EVENT_TYPES = Object.freeze([
  "conversation.created", "conversation.updated",
  "run.created", "run.state",
  "message.created", "message.consumed",
  "compaction.started", "compaction.completed", "compaction.aborted"
]);
