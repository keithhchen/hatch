import { ToolInvocation } from "../domain/ToolInvocation.js";
import type { AgentRun } from "../domain/AgentRun.js";
import type { Conversation } from "../domain/Conversation.js";
import type {
	AssistantMessage,
	Identifier,
	RuntimeEvent,
	ToolCallBlock,
	ToolResultMessage,
} from "../domain/types.js";
import type {
	Clock,
	IdentifierFactory,
	RuntimeEventPublisher,
	RuntimeUnitOfWork,
	ToolRegistry,
	ToolResult,
} from "../ports/runtime-ports.js";

export class ToolTurn {
	constructor(
		private readonly tools: ToolRegistry,
		private readonly unitOfWork: RuntimeUnitOfWork,
		private readonly events: RuntimeEventPublisher,
		private readonly identifiers: IdentifierFactory,
		private readonly clock: Clock,
	) {}

	async begin(
		conversation: Conversation,
		run: AgentRun,
		assistant: AssistantMessage,
		calls: ToolCallBlock[],
	): Promise<Map<Identifier, ToolInvocation>> {
		const invocations = calls.map((call) => new ToolInvocation(call.callId, run.id, call.name));
		run.waitForTools(calls.map((call) => call.callId));
		await this.unitOfWork.run(async (tx) => {
			conversation.append(assistant);
			await tx.conversations.append(conversation.id, assistant);
			for (const invocation of invocations) await tx.toolInvocations.add(invocation);
			await tx.runs.save(run);
		});
		await this.publish({ type: "message_appended", runId: run.id, message: assistant });
		await this.publish({ type: "run_status_changed", runId: run.id, status: run.status });
		for (const call of calls) {
			await this.publish({ type: "tool_started", runId: run.id, callId: call.callId, toolName: call.name });
		}
		return new Map(invocations.map((invocation) => [invocation.callId, invocation]));
	}

	async execute(
		conversation: Conversation,
		run: AgentRun,
		calls: ToolCallBlock[],
		signal: AbortSignal,
		invocations: Map<Identifier, ToolInvocation>,
	): Promise<void> {
		for (const call of calls) {
			const invocation = invocations.get(call.callId);
			if (invocation === undefined) throw new Error(`Tool call ${call.callId} was not registered`);
			await this.executeOne(conversation, run, call, invocation, signal);
		}
	}

	private async executeOne(
		conversation: Conversation,
		run: AgentRun,
		call: ToolCallBlock,
		invocation: ToolInvocation,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted) {
			await this.cancelInvocation(run, invocation, call.callId);
			return;
		}
		const tool = this.tools.get(call.name);
		let outcome: ToolResult;
		try {
			outcome = await tool.execute(call.arguments, {
				callId: call.callId,
				signal,
				onProgress: async (progress) => {
					await this.publish({
						type: "tool_progress",
						runId: run.id,
						callId: call.callId,
						message: progress.message,
					});
				},
			});
		} catch (error) {
			if (!signal.aborted) throw error;
			await this.cancelInvocation(run, invocation, call.callId);
			return;
		}
		if (signal.aborted) {
			await this.cancelInvocation(run, invocation, call.callId);
			return;
		}
		if (!outcome.isError) invocation.complete();
		else invocation.fail();

		const result: ToolResultMessage = {
			id: this.identifiers.create(),
			conversationId: conversation.id,
			runId: run.id,
			role: "toolResult",
			callId: call.callId,
			name: call.name,
			content: outcome.content,
			isError: outcome.isError,
			...(outcome.details === undefined ? {} : { details: outcome.details }),
			createdAt: this.clock.now(),
		};
		conversation.append(result);
		run.completeTool(call.callId);
		await this.unitOfWork.run(async (tx) => {
			await tx.conversations.append(conversation.id, result);
			await tx.toolInvocations.save(invocation);
			await tx.runs.save(run);
		});
		await this.publish({ type: "message_appended", runId: run.id, message: result });
		if (!outcome.isError) {
			await this.publish({ type: "tool_completed", runId: run.id, callId: call.callId });
		} else {
			const message = outcome.content.find((block) => block.type === "text")?.text ?? "Tool returned an error result";
			await this.publish({ type: "tool_failed", runId: run.id, callId: call.callId, message });
		}
		if (run.status === "running") {
			await this.publish({ type: "run_status_changed", runId: run.id, status: run.status });
		}
	}

	private async cancelInvocation(run: AgentRun, invocation: ToolInvocation, callId: Identifier): Promise<void> {
		invocation.cancel();
		run.completeTool(callId);
		await this.unitOfWork.run(async (tx) => {
			await tx.toolInvocations.save(invocation);
			await tx.runs.save(run);
		});
	}

	private async publish(event: RuntimeEvent): Promise<void> {
		await this.events.publish(event);
	}
}
