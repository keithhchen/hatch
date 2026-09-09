import type { ToolResultMessage } from "@earendil-works/pi-ai";
import type { ConversationMessage } from "./protocol.js";

export function persistToolMessage(message: ToolResultMessage): ConversationMessage {
  return {
    role: "tool", content: null,
    tool_call_id: message.toolCallId, tool_name: message.toolName,
    tool_content: structuredClone(message.content), tool_is_error: message.isError
  };
}

export function restoreToolMessage(message: Pick<ConversationMessage,
  "content" | "tool_content" | "tool_is_error" | "tool_call_id" | "tool_name">): ToolResultMessage {
  return {
    role: "toolResult", toolCallId: message.tool_call_id ?? "unknown-tool-call",
    toolName: message.tool_name ?? "tool",
    // Only old text-only records use content. New records are replayed verbatim.
    content: structuredClone(message.tool_content ?? [{ type: "text", text: message.content ?? "" }]),
    isError: message.tool_is_error ?? false, timestamp: 0
  };
}
