import type { ConversationEvent } from "../conversations/conversation.js";
import type { ConversationJournalEvent } from "../conversationRepository.js";

/** The account's Assistant conversation id in Chat, and the key of its feed in Studio. */
export const assistantConversationId = (accountId: string): string => `conversation:assistant:${accountId}`;
export const assistantFeedKey = (accountId: string): string => `assistant:${accountId}`;
/** The account behind an Assistant conversation id; nothing for any other conversation. */
export const accountOfConversation = (conversationId: string): string | undefined => /^conversation:assistant:([0-9a-f-]{36})$/.exec(conversationId)?.[1];
/** The Chat conversation behind a Studio feed key; nothing for a key that is not the Assistant's. */
export const conversationOfFeedKey = (key: string): string | undefined => {
  const account = /^assistant:([0-9a-f-]{36})$/.exec(key)?.[1];
  return account && assistantConversationId(account);
};

type Hubbed = Record<string, unknown>;

/** Where a Studio event comes from: what Chat recorded (it has a cursor), or what Chat is saying right now (it has none). */
export type StudioSource = { journal: ConversationJournalEvent } | { hub: Hubbed };

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

/**
 * What the journal says to a Studio observer, in Studio's own words: one event for each journal event, so the journal's cursor
 * names exactly one position and a reader that resumes after it finds the rest, none twice and none missing.
 * Every event names its Run, and its message when it has one.
 */
function ofJournal(event: ConversationJournalEvent): ConversationEvent[] {
  const run_id = event.runId;
  const about = (message_id: string | undefined) => ({ ...(run_id ? { run_id } : {}), ...(message_id ? { message_id } : {}) });
  const payload = event.payload;
  switch (event.type) {
    case "message.created":
      return payload.role === "user"
        ? [{ type: "message", ...about(text(payload.client_message_id)) }]
        : [{ type: "message_end", ...about(text(payload.message_id)) }];
    // A message the Run took up is now in the transcript: what was queued on the page is the conversation's.
    case "message.consumed": return [{ type: "state", ...about(text(payload.client_message_id)) }];
    // A Run that answers again has no message to announce it: the page learns of it here.
    case "run.created": return [{ type: "state", ...about(undefined) }];
    case "run.state": {
      const status = String(payload.status);
      if (status === "compacting") return [{ type: "compacting", ...about(undefined) }];
      if (status === "completed" || status === "failed" || status === "cancelled" || status === "interrupted") {
        return [{ type: "run_end", status, ...(payload.failure ? { error: payload.failure } : {}), ...about(undefined) }];
      }
      return [{ type: "state", ...about(undefined) }];
    }
    default: return [];
  }
}

/**
 * What a live Chat event means to a Studio observer: only what the journal does not hold. A step is what Chat shows of a tool
 * call, never its arguments or result. A text delta carries `offset`, its place in the Run's text, so a reader that joined
 * late (the snapshot's partial output) lines it up exactly. Events the journal records come from the journal, not from here.
 */
function ofHub(event: Hubbed): ConversationEvent[] {
  const run_id = text(event.run_id);
  const about = run_id ? { run_id } : {};
  switch (event.type) {
    case "assistant.delta": {
      const delta = event.delta as { kind?: string; content?: string; delta?: string; contentIndex?: number; offset?: number } | undefined;
      if (delta?.kind === "text" && delta.content) return [{ type: "delta", text: delta.content, ...(typeof delta.offset === "number" ? { offset: delta.offset } : {}), ...about }];
      // Reasoning is carried as Chat has it, per content index, so the page lays it among the steps and words as it happened.
      if (delta?.kind === "thinking_start") return [{ type: "thinking", contentIndex: delta.contentIndex, ...about }];
      if (delta?.kind === "thinking_delta") return [{ type: "thinking_delta", contentIndex: delta.contentIndex, delta: delta.delta, ...about }];
      return delta?.kind === "thinking_end" ? [{ type: "thinking_end", contentIndex: delta.contentIndex, content: delta.content, ...about }] : [];
    }
    case "tool_call.delta": {
      const name = String(event.name ?? "");
      const step = { name, id: event.tool_call_id, ...(event.activity_message ? { activity: event.activity_message } : {}), ...about };
      if (event.status === "requested") return [{ type: "tool", ...step }];
      // A step that was cancelled with its Run has ended too: it must not keep spinning.
      if (event.status === "cancelled") return [{ type: "tool_end", ...step, isError: false, cancelled: true }];
      return event.status === "completed" || event.status === "failed" ? [{ type: "tool_end", ...step, isError: event.status === "failed" }] : [];
    }
    // Something no Run shows changed, such as a chat being linked: observers look again.
    case "studio.touched": return [{ type: "state" }];
    default: return [];
  }
}

/** The one mapping from Chat's events to Studio's: a pure function of the journal's record or of what Chat says live. */
export function studioVocabulary(source: StudioSource): ConversationEvent[] {
  return "journal" in source ? ofJournal(source.journal) : ofHub(source.hub);
}
