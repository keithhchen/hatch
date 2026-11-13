import { createHash } from "node:crypto";
import type { BriefSnapshot } from "../brief.js";
import type { ConversationRecord, ConversationRunRecord } from "../conversationRepository.js";
import type { VisibleConversationMessage, VisibleConversationToolCall } from "../store.js";
import type { OutputFinishReason } from "../protocol.js";
import { modelIdOf } from "./models.js";
import { taskBriefObject } from "./taskBrief.js";

export type ResponseStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled" | "incomplete";
export type Json = Record<string, unknown>;

export const epochSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
const digest = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 24);

/** A response is the Run that answered: `resp_` + the Run's id without its own prefix. */
export const responseIdOf = (runId: string): string => `resp_${runId.replace(/^run_/, "")}`;
export const runIdOf = (responseId: string): string | undefined => /^resp_[A-Za-z0-9_-]{1,200}$/.test(responseId) ? `run_${responseId.slice("resp_".length)}` : undefined;

export const assistantItemId = (runId: string): string => `msg_${digest(`${runId}:assistant`)}`;
export const userItemId = (message: Pick<VisibleConversationMessage, "id" | "run_id">): string => `msg_${digest(message.id ?? `${message.run_id}:user`)}`;
export const toolCallItemId = (toolCallId: string): string => `hatch_call_${toolCallId}`;

export const conversationObject = (conversation: ConversationRecord): Json => ({
  id: conversation.publicId,
  object: "conversation",
  created_at: epochSeconds(conversation.createdAt),
  metadata: conversation.title ? { title: conversation.title } : {},
  model: modelIdOf(conversation.productId),
  task_brief: taskBriefObject(conversation.briefSnapshot as BriefSnapshot | undefined)
});

/** The words the model's reply is made of, as the output item an SDK reads. */
export const messageItem = (runId: string, text: string, status: "in_progress" | "completed" | "incomplete" = "completed"): Json => ({
  type: "message", id: assistantItemId(runId), role: "assistant", status,
  content: [{ type: "output_text", text, annotations: [] }]
});

const TOOL_STATUS: Record<VisibleConversationToolCall["status"], string> = { requested: "in_progress", completed: "completed", failed: "failed", cancelled: "failed" };
const asJson = (value: unknown): string => typeof value === "string" ? value : JSON.stringify(value ?? null);

/** Server tool activity, shown only on request (`include=hatch.tool_calls`). */
export const toolCallItem = (call: Pick<VisibleConversationToolCall, "tool_call_id" | "name" | "status" | "arguments" | "result" | "error">): Json => ({
  type: "hatch_tool_call", id: toolCallItemId(call.tool_call_id), name: call.name, status: TOOL_STATUS[call.status],
  arguments: asJson(call.arguments), output: call.result !== undefined ? asJson(call.result) : call.error !== undefined ? asJson(call.error) : null
});

/** A tool that waits for the caller's approval. The request's id is the tool call's. */
export const approvalRequestItem = (call: { toolCallId: string; name: string; arguments: Record<string, unknown> }): Json => ({
  type: "mcp_approval_request", id: call.toolCallId, server_label: "hatch", name: call.name, arguments: asJson(call.arguments)
});

/**
 * A Run's usage as the OpenAI shape tells it, from the ledger's one total for the Run. `input_tokens` counts the whole prompt,
 * as the ledger does (fresh, cache read and cache write); `cached_tokens` is the part read from cache.
 */
export function usageOf(total: { input: number; cachedInput: number; output: number; reasoning: number }): Json {
  return {
    input_tokens: total.input, input_tokens_details: { cached_tokens: total.cachedInput },
    output_tokens: total.output, output_tokens_details: { reasoning_tokens: total.reasoning },
    total_tokens: total.input + total.output
  };
}

export type RunView = {
  run: ConversationRunRecord;
  /** The reply the model produced; empty while there is none. */
  text: string;
  finishReason?: OutputFinishReason;
  toolCalls: Array<Pick<VisibleConversationToolCall, "tool_call_id" | "name" | "status" | "arguments" | "result" | "error">>;
  approvals: Array<{ toolCallId: string; name: string; arguments: Record<string, unknown> }>;
  usage: Json | null;
  previousRunId?: string;
  includeToolCalls: boolean;
};

const TERMINAL = new Set(["completed", "failed", "cancelled", "interrupted"]);
export const isTerminal = (status: string): boolean => TERMINAL.has(status);

/** What a Run's state is, told as a response's status, error and incompleteness. */
export function statusOf(view: Pick<RunView, "run" | "finishReason" | "approvals">): { status: ResponseStatus; error: Json | null; incomplete: Json | null } {
  const { run } = view;
  const failure = run.failure ? { code: run.failure.code, message: run.failure.reference ? `${run.failure.message} (reference ${run.failure.reference})` : run.failure.message } : undefined;
  switch (run.status) {
    case "queued": return { status: "queued", error: null, incomplete: null };
    case "completed":
      return view.finishReason === "content_filter" ? { status: "incomplete", error: null, incomplete: { reason: "content_filter" } }
        : view.finishReason === "length" ? { status: "incomplete", error: null, incomplete: { reason: "max_output_tokens" } }
        : { status: "completed", error: null, incomplete: null };
    case "failed": return { status: "failed", error: failure ?? { code: "run_failed", message: "The run failed." }, incomplete: null };
    case "interrupted": return { status: "failed", error: { code: "run_interrupted", message: failure?.message ?? "The run was interrupted by a restart. Send the request again." }, incomplete: null };
    case "cancelled": return { status: "cancelled", error: null, incomplete: null };
    default:
      return view.approvals.length ? { status: "incomplete", error: null, incomplete: { reason: "approval_required" } } : { status: "in_progress", error: null, incomplete: null };
  }
}

/** The output of a Run: its reply (or what was said before it stopped), then, when asked, its tool activity, then approvals it waits for. */
export function outputOf(view: RunView): Json[] {
  const { run } = view;
  const settled = isTerminal(run.status);
  const text = view.text || (run.status === "failed" || run.status === "cancelled" || run.status === "interrupted" ? run.partialOutput ?? "" : "");
  const messageStatus = !settled ? "in_progress" : run.status === "completed" && (view.finishReason ?? "stop") === "stop" ? "completed" : "incomplete";
  return [
    ...(text || (settled && run.status === "completed" && view.finishReason === "content_filter") ? [messageItem(run.id, text, messageStatus)] : []),
    ...(view.includeToolCalls ? view.toolCalls.map(toolCallItem) : []),
    ...view.approvals.map(approvalRequestItem)
  ];
}

/** The Response object of a Run. */
export function responseObject(conversation: ConversationRecord, view: RunView): Json {
  const { status, error, incomplete } = statusOf(view);
  const output = outputOf(view);
  const messages = output.filter((item) => item.type === "message") as Array<{ content: Array<{ text: string }> }>;
  return {
    id: responseIdOf(view.run.id), object: "response", created_at: epochSeconds(view.run.createdAt), status,
    model: modelIdOf(conversation.productId),
    conversation: { id: conversation.publicId },
    previous_response_id: view.previousRunId ? responseIdOf(view.previousRunId) : null,
    metadata: {},
    output,
    output_text: messages.map((item) => item.content[0]!.text).join(""),
    error, incomplete_details: incomplete,
    usage: view.usage
  };
}

/** A user message as a conversation item: the words, then each attachment by name (its bytes belong to the conversation). */
export type AttachedFile = { name: string; kind: string };
export function userMessageItem(message: VisibleConversationMessage, files: readonly AttachedFile[] = []): Json {
  const content: Json[] = [];
  if (message.content) content.push({ type: "input_text", text: message.content });
  for (const file of files) {
    content.push(file.kind === "image" ? { type: "input_image", image_url: null, detail: "auto", filename: file.name } : { type: "input_file", filename: file.name });
  }
  return { type: "message", id: userItemId(message), role: "user", status: "completed", content };
}

/** The items of a conversation, oldest first: user messages, and each reply with (when asked) the tool activity before it. */
export function conversationItems(messages: readonly VisibleConversationMessage[], includeToolCalls: boolean, userItem: (message: VisibleConversationMessage) => Json = (message) => userMessageItem(message)): Json[] {
  return messages.flatMap((message): Json[] => {
    if (message.role === "user") return [userItem(message)];
    return [
      ...(includeToolCalls ? (message.tool_calls ?? []).map(toolCallItem) : []),
      { ...messageItem(message.run_id, message.content), status: "completed" }
    ];
  });
}
