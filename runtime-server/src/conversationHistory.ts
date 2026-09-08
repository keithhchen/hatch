import { createHash } from "node:crypto";
import type { StoreEvent, VisibleConversationMessage } from "./store.js";

export type ConversationHistoryOptions = { limit?: number; beforeCursor?: string };
export type ConversationHistoryPage = {
  messages: VisibleConversationMessage[];
  has_more: boolean;
  before_cursor?: string;
  run_ids: string[];
};
export type ConversationToolDetailRef = { run_id: string; tool_call_id: string };

export class HistoryCursorError extends Error {
  readonly code = "history_cursor_invalid";
  constructor() { super("Invalid conversation history cursor"); this.name = "HistoryCursorError"; }
}

export function historyLimit(limit = 50): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("History limit must be an integer between 1 and 200");
  return limit;
}

const binding = (conversationId: string): string => createHash("sha256").update(conversationId).digest("hex");
export function historyCursor(conversationId: string, firstId: string): string {
  return Buffer.from(JSON.stringify([1, binding(conversationId), firstId])).toString("base64url");
}
export function historyBoundary(conversationId: string, cursor?: string): string | undefined {
  if (cursor === undefined) return undefined;
  try {
    if (cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (!Array.isArray(value) || value.length !== 3 || value[0] !== 1 || value[1] !== binding(conversationId)
      || typeof value[2] !== "string" || !/^[1-9][0-9]*$/.test(value[2]) || BigInt(value[2]) > 9223372036854775807n
      || historyCursor(conversationId, value[2]) !== cursor) throw new Error();
    return value[2];
  } catch { throw new HistoryCursorError(); }
}

export function isHistoryMessage(event: StoreEvent): boolean {
  return event.type === "message.created" || (event.type === "conversation.model_message" && (
    (event.message.role === "user" && event.message.kind !== "task_start")
    || (event.message.role === "assistant" && event.finish_reason !== undefined)
  ));
}

/** Only transport projections change; the durable event and attachment metadata never change. */
export function historyEvent(event: StoreEvent): StoreEvent {
  if (event.type === "tool.call") {
    const { result: _result, error: _error, arguments: _arguments, ...metadata } = event;
    return { ...metadata, arguments: {} };
  }
  if (event.type === "skill.activated") return { ...event, content: "" };
  return event;
}

export function historyMessages(conversationId: string, messages: VisibleConversationMessage[]): VisibleConversationMessage[] {
  const occurrences = new Map<string, number>();
  return messages.map((message) => {
    const key = JSON.stringify([conversationId, message.run_id, message.role]);
    const ordinal = occurrences.get(key) ?? 0;
    occurrences.set(key, ordinal + 1);
    return {
      ...message,
      id: `msg_${createHash("sha256").update(JSON.stringify([key, ordinal])).digest("hex")}`,
      ...(message.tool_calls ? { tool_calls: message.tool_calls.map((tool) => ({
        ...tool, detail_ref: { run_id: tool.run_id, tool_call_id: tool.tool_call_id }
      })) } : {})
    };
  });
}
