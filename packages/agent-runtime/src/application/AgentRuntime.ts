import { AgentRun } from "../domain/AgentRun.js";
import { Conversation } from "../domain/Conversation.js";
import type {
	Identifier,
	InputMode,
	RunHandle,
	RuntimeEvent,
	StartRunInput,
	UserMessage,
} from "../domain/types.js";
import type { AgentRuntimeDependencies } from "../domain/types.js";
import type { RuntimeSession } from "../ports/runtime-ports.js";
import { RunExecution, type RunControl } from "./RunExecution.js";

export class AgentRuntime {
	private readonly activeRuns = new Map<Identifier, RunControl>();

	constructor(private readonly dependencies: AgentRuntimeDependencies) {}

	async start(session: RuntimeSession, input: StartRunInput): Promise<RunHandle> {
		const run = new AgentRun(
			this.dependencies.identifiers.create(),
			input.conversationId,
			this.dependencies.clock.now(),
			input.parentRunId,
		);
		const userMessage: UserMessage = {
			id: this.dependencies.identifiers.create(),
			conversationId: input.conversationId,
			runId: run.id,
			role: "user",
			content: input.content,
			createdAt: this.dependencies.clock.now(),
		};
		const conversation = await this.dependencies.unitOfWork.run(async (tx) => {
			const existing = await tx.conversations.find(input.conversationId);
			const current = existing ?? new Conversation(input.conversationId, this.dependencies.clock.now());
			current.append(userMessage);
			if (existing === undefined) await tx.conversations.add(current);
			else await tx.conversations.append(current.id, userMessage);
			await tx.runs.add(run);
			return current;
		});

		const active: RunControl = {
			run,
			controller: new AbortController(),
		};
		this.activeRuns.set(run.id, active);
		await this.publish({ type: "run_started", runId: run.id, conversationId: run.conversationId });
		await this.publish({ type: "message_appended", runId: run.id, message: userMessage });
		const completion = new RunExecution(this.dependencies, session, active, conversation).start().finally(() => {
			this.activeRuns.delete(run.id);
		});
		return { runId: run.id, completion };
	}

	async steer(runId: Identifier, content: UserMessage["content"], mode: InputMode = "steer"): Promise<void> {
		const active = this.requireActiveRun(runId);
		const message: UserMessage = {
			id: this.dependencies.identifiers.create(),
			conversationId: active.run.conversationId,
			runId,
			role: "user",
			content,
			createdAt: this.dependencies.clock.now(),
		};
		active.run.queueInput(message, mode);
		await this.dependencies.unitOfWork.run(async (tx) => tx.runs.save(active.run));
		await this.publish({ type: "input_queued", runId, mode });
	}

	async cancel(runId: Identifier): Promise<void> {
		const active = this.requireActiveRun(runId);
		active.run.requestCancel();
		active.controller.abort(new Error("Run cancelled"));
		await this.dependencies.unitOfWork.run(async (tx) => tx.runs.save(active.run));
		await this.publish({ type: "run_cancel_requested", runId });
	}

	private requireActiveRun(runId: Identifier): RunControl {
		const active = this.activeRuns.get(runId);
		if (active === undefined) throw new Error(`Run ${runId} is not active in this runtime`);
		return active;
	}

	private async publish(event: RuntimeEvent): Promise<void> {
		await this.dependencies.events.publish(event);
	}
}
