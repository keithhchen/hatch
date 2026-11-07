import type { AgentRun } from "../domain/AgentRun.js";
import type { Conversation } from "../domain/Conversation.js";
import type {
	AssistantMessage,
	ContentBlock,
	Identifier,
	ModelContext,
	ModelEvent,
	ModelResponseMetadata,
	RuntimeEvent,
	ToolCallBlock,
} from "../domain/types.js";
import type {
	Clock,
	ContextBuilder,
	IdentifierFactory,
	Model,
	RuntimeEventPublisher,
	RuntimeUnitOfWork,
	ToolRegistry,
} from "../ports/runtime-ports.js";

export interface ModelTurnResult {
	message: AssistantMessage;
	toolCalls: ToolCallBlock[];
	metadata: ModelResponseMetadata;
}

export class ModelTurn {
	constructor(
		private readonly model: Model,
		private readonly contextBuilder: ContextBuilder,
		private readonly tools: ToolRegistry,
		private readonly unitOfWork: RuntimeUnitOfWork,
		private readonly events: RuntimeEventPublisher,
		private readonly identifiers: IdentifierFactory,
		private readonly clock: Clock,
	) {}

	async run(conversation: Conversation, run: AgentRun, signal: AbortSignal): Promise<ModelTurnResult> {
		const build = await this.contextBuilder.build(
			conversation,
			run,
			this.tools.list().map((tool) => tool.definition),
		);
		if (build.compactions.length > 0) {
			await this.unitOfWork.run(async (tx) => {
				for (const record of build.compactions) await tx.conversations.appendCompaction(record);
			});
			for (const record of build.compactions) {
				conversation.appendCompaction(record);
				await this.publish({
					type: "context_compaction_completed",
					runId: run.id,
					firstKeptMessageId: record.firstKeptMessageId,
				});
			}
		}

		const { content, toolCalls, metadata } = await this.collect(build.context, run.id, signal);
		return {
			message: {
				id: this.identifiers.create(),
				conversationId: conversation.id,
				runId: run.id,
				role: "assistant",
				content,
				model: metadata,
				createdAt: this.clock.now(),
			},
			toolCalls,
			metadata,
		};
	}

	private async collect(
		context: ModelContext,
		runId: Identifier,
		signal: AbortSignal,
	): Promise<{ content: ContentBlock[]; toolCalls: ToolCallBlock[]; metadata: ModelResponseMetadata }> {
		const content: ContentBlock[] = [];
		const toolCalls: ToolCallBlock[] = [];
		let completed = false;
		let metadata: ModelResponseMetadata | undefined;
		for await (const event of this.model.stream(context, signal)) {
			await this.accept(event, runId, content, toolCalls);
			if (event.type === "turn_complete") {
				completed = true;
				metadata = event.metadata;
				break;
			}
		}
		if (!completed) throw new Error("Model stream ended before completing the turn");
		if (metadata === undefined) throw new Error("Model completed the turn without response metadata");
		return { content, toolCalls, metadata };
	}

	private async accept(
		event: ModelEvent,
		runId: Identifier,
		content: ContentBlock[],
		toolCalls: ToolCallBlock[],
	): Promise<void> {
		switch (event.type) {
			case "text_delta": {
				const delta = { type: "text", text: event.text } as const;
				const previous = content.at(-1);
				if (previous?.type === "text") previous.text += event.text;
				else content.push({ ...delta });
				await this.publish({ type: "message_delta", runId, delta });
				return;
			}
			case "thinking_delta": {
				const delta = { type: "thinking", thinking: event.thinking } as const;
				const previous = content.at(-1);
				if (previous?.type === "thinking") previous.thinking += event.thinking;
				else content.push({ ...delta });
				await this.publish({ type: "message_delta", runId, delta });
				return;
			}
			case "thinking_signature": {
				const previous = content.at(-1);
				if (previous?.type !== "thinking") {
					content.push({ type: "thinking", thinking: "", signature: event.signature });
				} else {
					previous.signature = event.signature;
				}
				await this.publish({
					type: "message_delta",
					runId,
					delta: { type: "thinking", thinking: "", signature: event.signature },
				});
				return;
			}
			case "tool_call":
				content.push(event.call);
				toolCalls.push(event.call);
				return;
			case "turn_complete":
				return;
		}
	}

	private async publish(event: RuntimeEvent): Promise<void> {
		await this.events.publish(event);
	}
}
