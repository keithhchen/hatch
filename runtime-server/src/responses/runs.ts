import type { ConversationRecord, ConversationRepository, ConversationRunRecord } from "../conversationRepository.js";
import type { ChatEdge } from "../chat/turnSubmission.js";
import type { RuntimeStore } from "../store.js";
import type { VisibleConversationMessage } from "../store.js";
import { attachmentMessageId, type ChatAssets } from "../chat/assets.js";
import { isTerminal, responseObject, usageOf, userMessageItem, type AttachedFile, type Json, type RunView } from "./mapping.js";

/**
 * What the domain knows of a Run, read as a response: its reply and tool activity from the transcript, its usage from the
 * calls each model turn persisted, the approvals it waits for from the durable tool requests. Reads only; it decides nothing.
 */
export class RunViews {
  constructor(private readonly deps: { repository: ConversationRepository; store: RuntimeStore; chat: ChatEdge["chat"]; assets?: ChatAssets }) {}

  /** How a user message of this conversation is shown: its words and the files it carried. */
  async userItems(conversation: ConversationRecord): Promise<(message: VisibleConversationMessage) => Json> {
    const byMessage = new Map<string, AttachedFile[]>();
    for (const { asset, messageId } of await this.deps.assets?.attachments(conversation) ?? []) {
      byMessage.set(messageId, [...byMessage.get(messageId) ?? [], { name: asset.record.name, kind: asset.record.kind }]);
    }
    return (message) => userMessageItem(message, byMessage.get(attachmentMessageId(message.id ?? "")) ?? []);
  }

  async view(conversation: ConversationRecord, run: ConversationRunRecord, includeToolCalls: boolean): Promise<RunView> {
    const { repository, store, chat } = this.deps;
    const events = await store.readEvents(conversation.id);
    const reply = (await store.readVisibleConversation(conversation.id, events))
      .filter((message) => message.role === "assistant" && message.run_id === run.id).at(-1);
    const runs = await repository.listRuns(conversation.id);
    const at = runs.findIndex((row) => row.id === run.id);
    return {
      run, includeToolCalls,
      text: reply?.content ?? run.partialOutput ?? "",
      ...(reply?.finish_reason ? { finishReason: reply.finish_reason } : {}),
      toolCalls: reply?.tool_calls ?? [],
      approvals: await this.approvals(conversation, run, chat),
      usage: isTerminal(run.status) ? usageOf(events, run.id) : null,
      ...(at > 0 ? { previousRunId: runs[at - 1]!.id } : {})
    };
  }

  async response(conversation: ConversationRecord, run: ConversationRunRecord, includeToolCalls: boolean): Promise<Json> {
    return responseObject(conversation, await this.view(conversation, run, includeToolCalls));
  }

  /** Tools the Run waits on the caller to approve. Only a Run that waits for a tool has any. */
  private async approvals(conversation: ConversationRecord, run: ConversationRunRecord, chat: ChatEdge["chat"]): Promise<RunView["approvals"]> {
    if (run.status !== "waiting_for_tool") return [];
    return (await chat.pendingToolRequests(conversation.id))
      .filter((request) => request.run_id === run.id && request.approval === "ask")
      .map((request) => ({ toolCallId: request.tool_call_id, name: request.name, arguments: request.arguments }));
  }
}
