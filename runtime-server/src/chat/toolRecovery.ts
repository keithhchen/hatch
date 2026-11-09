import type { ConversationRepository, ConversationRunRecord, ToolCallRecord } from "../conversationRepository.js";
import type { ConversationMessage } from "../protocol.js";
import { isReadOnlyTool } from "../tools.js";
import { CLIENT_TOOL_NAMES } from "./toolSurface.js";

export type DanglingCall = { id: string; name: string };

/** What to do with the calls a dead executor left unanswered. */
export type RecoveryPlan =
  | { kind: "ready"; results: ConversationMessage[] }
  | { kind: "wait"; calls: ToolCallRecord[] }
  | { kind: "interrupt"; reason: string };

/** The calls of the transcript's last assistant message that have no result yet. */
export function danglingCalls(history: readonly ConversationMessage[]): DanglingCall[] {
  const last = history.map((message) => message.role).lastIndexOf("assistant");
  const calls = history[last]?.tool_calls ?? [];
  const answered = new Set(history.slice(last + 1).flatMap((message) => message.role === "tool" && message.tool_call_id ? [message.tool_call_id] : []));
  return calls.filter((call) => !answered.has(call.id)).map((call) => ({ id: call.id, name: call.function.name }));
}

const result = (call: DanglingCall, text: string, isError: boolean): ConversationMessage => ({
  role: "tool", content: null, tool_call_id: call.id, tool_name: call.name, tool_content: [{ type: "text", text }], tool_is_error: isError
});
const failure = (call: DanglingCall, message: string): ConversationMessage =>
  result(call, JSON.stringify({ status: "error", error: { code: "tool_not_completed", message } }), true);
const withoutBytes = ({ data_base64: _bytes, ...rest }: Record<string, unknown>): Record<string, unknown> => rest;

/**
 * The explicit policy for a Run taken over mid-turn. The transcript already holds every call that finished,
 * and a finished call is never run again. For one that did not:
 * - a local tool the client answered: its answer is the result; unanswered, the Run keeps waiting until the call expires, then it times out;
 * - a local tool that never reached a client: reissuable, the model is told;
 * - a read-only server tool: no effect to repeat, the model is told it did not finish;
 * - any other server tool: it may have had an effect and must not run twice, so the Run is interrupted.
 */
export class ToolRecovery {
  constructor(private readonly deps: {
    repository: Pick<ConversationRepository, "listToolCalls">;
    isReadOnly?: (tool: string) => boolean;
    now?: () => number;
  }) {}

  async plan(run: Pick<ConversationRunRecord, "id">, history: readonly ConversationMessage[]): Promise<RecoveryPlan> {
    const dangling = danglingCalls(history);
    if (!dangling.length) return { kind: "ready", results: [] };
    const records = new Map((await this.deps.repository.listToolCalls(run.id)).map((record) => [record.toolCallId, record]));
    const now = (this.deps.now ?? Date.now)();
    const results: ConversationMessage[] = [];
    const waiting: ToolCallRecord[] = [];
    for (const call of dangling) {
      const record = records.get(call.id);
      if (!record) {
        if (CLIENT_TOOL_NAMES.includes(call.name as never) || (this.deps.isReadOnly ?? isReadOnlyTool)(call.name)) {
          results.push(failure(call, `The Runtime restarted before ${call.name} was run. It did not run; call it again if it is still needed.`));
          continue;
        }
        return { kind: "interrupt", reason: `The Runtime restarted while ${call.name} was running. It may or may not have had an effect and was not run again. Send the message again to continue.` };
      }
      if (record.outcome?.status === "ok") results.push(result(call, JSON.stringify(withoutBytes(record.outcome.result)), false));
      else if (record.outcome) results.push(failure(call, record.outcome.error.message));
      else if (Date.parse(record.expiresAt) <= now) results.push(failure(call, `Timed out waiting for client tool result: ${call.name}`));
      else waiting.push(record);
    }
    return waiting.length ? { kind: "wait", calls: waiting } : { kind: "ready", results };
  }
}
