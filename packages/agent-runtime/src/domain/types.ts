export type Identifier = string;

export interface TextBlock {
	type: "text";
	text: string;
}

export interface ImageBlock {
	type: "image";
	data: string;
	mimeType: string;
}

export interface ThinkingBlock {
	type: "thinking";
	thinking: string;
	signature?: string;
}

export interface ToolCallBlock {
	type: "toolCall";
	callId: Identifier;
	name: string;
	arguments: unknown;
	providerMetadata?: { provider: string; value: unknown };
}

export type ContentBlock = TextBlock | ImageBlock | ThinkingBlock | ToolCallBlock;
export type UserContentBlock = TextBlock | ImageBlock;

export interface SystemMessage {
	role: "system";
	content: string;
}

export interface UserMessage {
	id: Identifier;
	conversationId: Identifier;
	runId: Identifier;
	role: "user";
	content: UserContentBlock[];
	createdAt: string;
}

export interface AssistantMessage {
	id: Identifier;
	conversationId: Identifier;
	runId: Identifier;
	role: "assistant";
	content: ContentBlock[];
	model?: ModelResponseMetadata;
	createdAt: string;
}

export interface ModelResponseMetadata {
	api: string;
	provider: string;
	model: string;
	stopReason: "stop" | "length" | "toolUse" | "deferred";
	responseId?: string;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
}

export interface ToolResultMessage {
	id: Identifier;
	conversationId: Identifier;
	runId: Identifier;
	role: "toolResult";
	callId: Identifier;
	name: string;
	content: Array<TextBlock | ImageBlock>;
	isError: boolean;
	details?: unknown;
	createdAt: string;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;
export type ModelMessage = SystemMessage | Message;

export interface ToolDefinition {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
}

export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled";

export interface RunSnapshot {
	id: Identifier;
	conversationId: Identifier;
	status: RunStatus;
	cancelRequested: boolean;
	queuedInputs: QueuedInput[];
	pendingToolCallIds: Identifier[];
	parentRunId?: Identifier;
	startedAt: string;
	endedAt?: string;
	error?: string;
}

export type ToolInvocationStatus = "running" | "completed" | "failed" | "cancelled";

export interface ToolInvocationSnapshot {
	callId: Identifier;
	runId: Identifier;
	toolName: string;
	status: ToolInvocationStatus;
}

export interface ConversationSnapshot {
	id: Identifier;
	createdAt: string;
	messages: Message[];
	compactions: CompactionRecord[];
}

export interface CompactionRecord {
	conversationId: Identifier;
	runId: Identifier;
	summary: string;
	firstKeptMessageId: Identifier;
	createdAt: string;
}

export interface ModelContext {
	messages: ModelMessage[];
	tools: ToolDefinition[];
}

export type ModelEvent =
	| { type: "text_delta"; text: string }
	| { type: "thinking_delta"; thinking: string }
	| { type: "thinking_signature"; signature: string }
	| { type: "tool_call"; call: ToolCallBlock }
	| { type: "turn_complete"; metadata: ModelResponseMetadata };

export interface ToolProgress {
	message: string;
}

export type RuntimeEvent =
	| { type: "run_started"; runId: Identifier; conversationId: Identifier }
	| { type: "run_status_changed"; runId: Identifier; status: RunStatus }
	| { type: "run_cancel_requested"; runId: Identifier }
	| { type: "input_queued"; runId: Identifier; mode: InputMode }
	| { type: "message_appended"; runId: Identifier; message: Message }
	| { type: "message_delta"; runId: Identifier; delta: TextBlock | ThinkingBlock }
	| { type: "context_compaction_started"; runId: Identifier }
	| { type: "context_compaction_progress"; runId: Identifier; message: string }
	| { type: "context_compaction_completed"; runId: Identifier; firstKeptMessageId: Identifier }
	| { type: "tool_started"; runId: Identifier; callId: Identifier; toolName: string }
	| { type: "tool_progress"; runId: Identifier; callId: Identifier; message: string }
	| { type: "tool_completed"; runId: Identifier; callId: Identifier }
	| { type: "tool_failed"; runId: Identifier; callId: Identifier; message: string }
	| { type: "run_completed"; runId: Identifier }
	| { type: "run_failed"; runId: Identifier; message: string }
	| { type: "run_cancelled"; runId: Identifier };

export type InputMode = "steer" | "followUp";

export interface QueuedInput {
	message: UserMessage;
	mode: InputMode;
}

export interface StartRunInput {
	conversationId: Identifier;
	content: UserContentBlock[];
	parentRunId?: Identifier;
}

export interface RunHandle {
	runId: Identifier;
	completion: Promise<void>;
}

export interface AgentRuntimeDependencies {
	unitOfWork: import("../ports/runtime-ports.js").RuntimeUnitOfWork;
	events: import("../ports/runtime-ports.js").RuntimeEventPublisher;
	identifiers: import("../ports/runtime-ports.js").IdentifierFactory;
	clock: import("../ports/runtime-ports.js").Clock;
}
