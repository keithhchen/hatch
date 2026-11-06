import { AgentRun } from "../domain/AgentRun.js";
import type { Conversation } from "../domain/Conversation.js";
import type { AssistantMessage, Identifier, RuntimeEvent } from "../domain/types.js";
import type { AgentRuntimeDependencies } from "../domain/types.js";
import type { RuntimeSession } from "../ports/runtime-ports.js";
import { ModelTurn } from "./ModelTurn.js";
import { ToolTurn } from "./ToolTurn.js";
import { RequestModelPhase, type RunPhase } from "./RunPhase.js";

export interface RunControl {
	run: AgentRun;
	controller: AbortController;
}

export class RunExecution {
	private readonly modelTurn: ModelTurn;
	private readonly toolTurn: ToolTurn;

	constructor(
		private readonly dependencies: AgentRuntimeDependencies,
		session: RuntimeSession,
		private readonly active: RunControl,
		private readonly conversation: Conversation,
	) {
		this.modelTurn = new ModelTurn(
			session.model,
			session.contextBuilder,
			session.toolRegistry,
			dependencies.unitOfWork,
			dependencies.events,
			dependencies.identifiers,
			dependencies.clock,
		);
		this.toolTurn = new ToolTurn(
			session.toolRegistry,
			dependencies.unitOfWork,
			dependencies.events,
			dependencies.identifiers,
			dependencies.clock,
		);
	}

	get cancelRequested(): boolean {
		return this.active.run.cancelRequested;
	}

	async start(): Promise<void> {
		let phase: RunPhase | undefined = new RequestModelPhase();
		try {
			while (phase !== undefined) phase = await phase.advance(this);
		} catch (error) {
			if (this.active.run.cancelRequested) {
				await this.finishCancelled();
				return;
			}
			if (this.active.run.status === "completed" || this.active.run.status === "failed" || this.active.run.status === "cancelled") {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.active.run.fail(message, this.dependencies.clock.now());
			await this.dependencies.unitOfWork.run(async (tx) => tx.runs.save(this.active.run));
			await this.publish({ type: "run_failed", runId: this.active.run.id, message });
		}
	}

	async requestModelTurn(): Promise<import("./ModelTurn.js").ModelTurnResult> {
		await this.persistSteeringInputs();
		return this.modelTurn.run(
			this.conversation,
			this.active.run,
			this.active.controller.signal,
		);
	}

	async executeTools(result: import("./ModelTurn.js").ModelTurnResult): Promise<void> {
		const invocations = await this.toolTurn.begin(
			this.conversation,
			this.active.run,
			result.message,
			result.toolCalls,
		);
		await this.toolTurn.execute(
			this.conversation,
			this.active.run,
			result.toolCalls,
			this.active.controller.signal,
			invocations,
		);
	}

	async completeRun(): Promise<void> {
		this.active.run.complete(this.dependencies.clock.now());
		await this.dependencies.unitOfWork.run(async (tx) => tx.runs.save(this.active.run));
		await this.publish({
			type: "run_status_changed",
			runId: this.active.run.id,
			status: this.active.run.status,
		});
		if (this.active.run.status === "completed") {
			await this.publish({ type: "run_completed", runId: this.active.run.id });
		} else {
			await this.publish({ type: "run_cancelled", runId: this.active.run.id });
		}
	}

	private async persistSteeringInputs(): Promise<void> {
		const messages = this.active.run.takeInputs("steer");
		if (messages.length === 0) return;
		for (const message of messages) this.conversation.append(message);
		await this.dependencies.unitOfWork.run(async (tx) => {
			for (const message of messages) await tx.conversations.append(this.conversation.id, message);
			await tx.runs.save(this.active.run);
		});
		for (const message of messages) {
			await this.publish({ type: "message_appended", runId: this.active.run.id, message });
		}
	}

	async appendAssistantAndQueuedInputs(message: AssistantMessage): Promise<boolean> {
		const queuedInputs = this.active.run.takeAllInputs();
		this.conversation.append(message);
		for (const queued of queuedInputs) this.conversation.append(queued);
		await this.dependencies.unitOfWork.run(async (tx) => {
			await tx.conversations.append(this.conversation.id, message);
			for (const queued of queuedInputs) {
				await tx.conversations.append(this.conversation.id, queued);
			}
			await tx.runs.save(this.active.run);
		});
		await this.publish({ type: "message_appended", runId: this.active.run.id, message });
		for (const queued of queuedInputs) {
			await this.publish({ type: "message_appended", runId: this.active.run.id, message: queued });
		}
		return queuedInputs.length > 0;
	}

	async finishCancelled(): Promise<void> {
		if (this.active.run.status === "completed" || this.active.run.status === "failed" || this.active.run.status === "cancelled") return;
		this.active.run.cancel(this.dependencies.clock.now());
		await this.dependencies.unitOfWork.run(async (tx) => tx.runs.save(this.active.run));
		await this.publish({
			type: "run_status_changed",
			runId: this.active.run.id,
			status: this.active.run.status,
		});
		await this.publish({ type: "run_cancelled", runId: this.active.run.id });
	}

	private async publish(event: RuntimeEvent): Promise<void> {
		await this.dependencies.events.publish(event);
	}
}
