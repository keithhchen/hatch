import type { ConversationRunRecord } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import type { RuntimeStore } from "../store.js";

/** The calls of the transcript's last assistant message that have no result yet. */
export function danglingCalls(history: readonly ConversationMessage[]): Array<{ id: string; name: string }> {
  const last = history.map((message) => message.role).lastIndexOf("assistant");
  const calls = history[last]?.tool_calls ?? [];
  const answered = new Set(history.slice(last + 1).flatMap((message) => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []));
  return calls.filter((call) => !answered.has(call.id)).map((call) => ({ id: call.id, name: call.function.name }));
}

/**
 * A Run is never continued after its executor is gone, but the next Run reads its transcript, and a tool call
 * without a result would make the model provider reject it. Each such call is answered with an error saying it
 * may or may not have run, and that it is not run again.
 */
export async function closeDanglingCalls(store: Pick<RuntimeStore, "append" | "readConversation">, run: Pick<ConversationRunRecord, "id" | "conversationId">): Promise<void> {
  for (const call of danglingCalls(await store.readConversation(run.conversationId))) {
    const text = JSON.stringify({ status: "error", error: { code: "tool_not_completed", message: `The Runtime restarted while ${call.name} was running. It may or may not have had an effect and was not run again.` } });
    await store.append({
      type: "conversation.model_message", conversation_id: run.conversationId, run_id: run.id,
      message: { role: "tool", content: null, tool_call_id: call.id, tool_name: call.name, tool_content: [{ type: "text", text }], tool_is_error: true }
    });
  }
}
