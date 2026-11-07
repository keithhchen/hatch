import type { AgentRun } from "../domain/AgentRun.js";
import type { Conversation } from "../domain/Conversation.js";
import type { ToolInvocation } from "../domain/ToolInvocation.js";
import type {
	CompactionRecord,
	ConversationSnapshot,
	Identifier,
	Message,
	ModelContext,
	ModelEvent,
	RuntimeEvent,
	ToolDefinition,
	ToolProgress,
	TextBlock,
	ImageBlock,
} from "../domain/types.js";

export interface Model {
	stream(context: ModelContext, signal: AbortSignal): AsyncIterable<ModelEvent>;
}

/** Capabilities resolved and scoped by the consuming application for one run. */
export interface RuntimeSession {
	readonly model: Model;
	readonly contextBuilder: ContextBuilder;
	readonly toolRegistry: ToolRegistry;
}

export interface ToolExecutionContext {
	callId: Identifier;
	signal: AbortSignal;
	onProgress(progress: ToolProgress): Promise<void>;
}

export interface ToolResult {
	content: Array<TextBlock | ImageBlock>;
	isError: boolean;
	details?: unknown;
}

export interface Tool {
	readonly definition: ToolDefinition;
	execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}

export interface ToolRegistry {
	list(): readonly Tool[];
	get(name: string): Tool;
}

export interface ContextBuildResult {
	context: ModelContext;
	compactions: CompactionRecord[];
}

export interface ContextBuilder {
	build(
		conversation: Conversation,
		run: AgentRun,
		availableTools: readonly ToolDefinition[],
	): Promise<ContextBuildResult>;
}

export interface ConversationRepository {
	find(id: Identifier): Promise<Conversation | undefined>;
	add(conversation: Conversation): Promise<void>;
	append(conversationId: Identifier, message: Message): Promise<void>;
	appendCompaction(record: CompactionRecord): Promise<void>;
	list(): Promise<ConversationSnapshot[]>;
}

export interface RunRepository {
	find(id: Identifier): Promise<AgentRun | undefined>;
	add(run: AgentRun): Promise<void>;
	save(run: AgentRun): Promise<void>;
}

export interface ToolInvocationRepository {
	find(callId: Identifier): Promise<ToolInvocation | undefined>;
	listForRun(runId: Identifier): Promise<ToolInvocation[]>;
	add(invocation: ToolInvocation): Promise<void>;
	save(invocation: ToolInvocation): Promise<void>;
}

export interface RuntimeTransaction {
	conversations: ConversationRepository;
	runs: RunRepository;
	toolInvocations: ToolInvocationRepository;
}

export interface RuntimeUnitOfWork {
	run<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T>;
}

export interface RuntimeEventPublisher {
	publish(event: RuntimeEvent): Promise<void>;
}

export interface IdentifierFactory {
	create(): Identifier;
}

export interface Clock {
	now(): string;
}
