import { z } from "zod";

export const PROTOCOL_VERSION = "0.3";
export const ClientToolNameSchema = z.enum([
  "fs.list",
  "fs.search",
  "fs.read",
  "fs.write",
  "fs.patch",
  "shell.exec",
  "git.diff"
]);
export type ClientToolName = z.infer<typeof ClientToolNameSchema>;

export const ClientHelloSchema = z.object({
  type: z.literal("client.hello"),
  protocol_version: z.literal(PROTOCOL_VERSION),
  installation_id: z.string().min(1),
  license_token: z.string().min(1),
  client_version: z.string().optional(),
  workspace_root: z.string().min(1).optional(),
  local_tools: z.array(ClientToolNameSchema)
}).strict().superRefine((message, ctx) => {
  if (message.local_tools.length > 0 && !message.workspace_root) {
    ctx.addIssue({
      code: "custom",
      path: ["workspace_root"],
      message: "workspace_root is required when local_tools are declared"
    });
  }
});

export const ClientMessageSchema = z.object({
  type: z.literal("client.message"),
  run_id: z.string().min(1),
  conversation_id: z.string().min(1),
  message: z.object({
    role: z.literal("user"),
    content: z.string()
  }).strict()
}).strict();

export const ToolCallResultSchema = z.discriminatedUnion("status", [
  z.object({
    type: z.literal("tool_call.result"),
    run_id: z.string().min(1),
    tool_call_id: z.string().min(1),
    status: z.literal("ok"),
    result: z.record(z.string(), z.unknown())
  }).strict(),
  z.object({
    type: z.literal("tool_call.result"),
    run_id: z.string().min(1),
    tool_call_id: z.string().min(1),
    status: z.literal("error"),
    error: z.object({
      code: z.string(),
      message: z.string()
    }).strict()
  }).strict()
]);

export const TurnCancelSchema = z.object({
  type: z.literal("turn.cancel"),
  run_id: z.string().min(1),
  reason: z.string().optional()
}).strict();

export const InboundMessageSchema = z.discriminatedUnion("type", [
  ClientHelloSchema,
  ClientMessageSchema,
  ToolCallResultSchema,
  TurnCancelSchema
]);

export type ClientHello = z.infer<typeof ClientHelloSchema>;
export type RunStart = z.infer<typeof ClientMessageSchema>;
export type ToolResult = z.infer<typeof ToolCallResultSchema>;
export type RunCancel = z.infer<typeof TurnCancelSchema>;
export type InboundMessage = z.infer<typeof InboundMessageSchema>;
export type ConversationMessage = {
  role: "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
};

export type RuntimeReady = {
  type: "session.ready";
  accepted_protocol_version: typeof PROTOCOL_VERSION;
};

export type AgentDelta = {
  type: "assistant.delta";
  run_id: string;
  delta: {
    kind: "text" | "status";
    content: string;
  };
};

export type ToolRequest = {
  type: "tool_call.request";
  run_id: string;
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  approval: "none" | "auto" | "ask";
  scope?: "main" | "skill_run";
  skill_run_id?: string;
};

export type ApprovalRequest = {
  type: "approval.request";
  run_id: string;
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  reason?: string;
};

export type ApprovalResult = {
  type: "approval.result";
  run_id: string;
  tool_call_id: string;
  name: string;
  status: "approved" | "denied";
  reason?: string;
};

export type ToolEvent = {
  type: "tool_call.delta";
  run_id: string;
  tool_call_id: string;
  name: string;
  locality: "server" | "client";
  approval: "none" | "auto" | "ask";
  status: "requested" | "completed" | "failed" | "cancelled";
  arguments?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
  };
  scope?: "main" | "skill_run";
  skill_run_id?: string;
};

export type SkillRunEvent = {
  type: "skill.run";
  run_id: string;
  skill_run_id: string;
  skill_id: string;
  name: string;
  status: "requested" | "running" | "completed" | "failed" | "cancelled";
  error?: {
    code: string;
    message: string;
  };
};

export type WorkspaceDiffEvent = {
  type: "workspace.diff";
  run_id: string;
  source_tool_call_id: string;
  path: string;
  diff: string;
  truncated?: boolean;
};

export type SkillEvent = {
  type: "skill.invoked";
  run_id: string;
  name: string;
  path: string;
  scope: string;
  status: "invoked";
  invocation_type: "implicit";
  source_tool_call_id: string;
  reason: "script_run" | "skill_doc_read";
  trigger: {
    tool: "shell_exec" | "file_read";
    command?: string;
    path?: string;
  };
};

export type SkillActivatedEvent = {
  type: "skill.activated";
  run_id: string;
  name: string;
  path: string;
  scope: string;
  status: "activated";
  invocation_type: "explicit";
  reason: "explicit_mention";
  resource_paths: string[];
  resource_manifest_truncated: boolean;
};

export type RunStateEvent = {
  type: "turn.state";
  run_id: string;
  status: "queued" | "running" | "waiting_for_tool" | "compacting" | "completed" | "failed" | "cancelled";
  reason?: string;
};

export type CompactionEvent = {
  type: "session.compacted";
  run_id: string;
  trigger: "auto" | "manual";
  phase: "pre_turn" | "mid_turn" | "standalone_turn";
  reason: "context_limit" | "user_requested";
  message: string;
  replacement_history: ConversationMessage[];
  window_number: number;
  first_window_id: string;
  previous_window_id?: string;
  window_id: string;
};

export type RunFinal = {
  type: "turn.completed";
  run_id: string;
  output: Array<{
    type: "message";
    content: string;
  }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
};

export type RunError = {
  type: "turn.failed";
  run_id?: string;
  error: {
    code: string;
    message: string;
  };
};

export type OutboundMessage = RuntimeReady | AgentDelta | ToolRequest | ApprovalRequest | ApprovalResult | ToolEvent | SkillRunEvent | WorkspaceDiffEvent | SkillEvent | SkillActivatedEvent | RunStateEvent | CompactionEvent | RunFinal | RunError;

export function parseInboundMessage(raw: unknown): InboundMessage {
  return InboundMessageSchema.parse(raw);
}
