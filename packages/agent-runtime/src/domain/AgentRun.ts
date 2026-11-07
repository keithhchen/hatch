import type {
	Identifier,
	InputMode,
	QueuedInput,
	RunStatus,
	RunSnapshot,
	UserMessage,
} from "./types.js";

export class AgentRun {
	private currentStatus: RunStatus = "running";
	private cancelWasRequested = false;
	private readonly queuedInputs: QueuedInput[] = [];
	private readonly pendingToolCalls = new Set<Identifier>();
	private endedAtValue: string | undefined;
	private errorValue: string | undefined;

	constructor(
		readonly id: Identifier,
		readonly conversationId: Identifier,
		readonly startedAt: string,
		readonly parentRunId?: Identifier,
	) {}

	get status(): RunStatus {
		return this.currentStatus;
	}

	get cancelRequested(): boolean {
		return this.cancelWasRequested;
	}

	requestCancel(): void {
		this.assertActive();
		this.cancelWasRequested = true;
	}

	queueInput(message: UserMessage, mode: InputMode): void {
		this.assertActive();
		if (message.conversationId !== this.conversationId || message.runId !== this.id) {
			throw new Error("Queued input belongs to another run");
		}
		this.queuedInputs.push({ message, mode });
	}

	takeInputs(mode: InputMode): UserMessage[] {
		const selected: UserMessage[] = [];
		for (let index = this.queuedInputs.length - 1; index >= 0; index -= 1) {
			const queued = this.queuedInputs[index];
			if (queued?.mode === mode) {
				selected.unshift(queued.message);
				this.queuedInputs.splice(index, 1);
			}
		}
		return selected;
	}

	takeAllInputs(): UserMessage[] {
		return this.queuedInputs.splice(0).map((queued) => queued.message);
	}

	waitForTools(callIds: Identifier[]): void {
		this.assertActive();
		if (callIds.length === 0) {
			throw new Error("A run can wait only for at least one tool call");
		}
		this.pendingToolCalls.clear();
		for (const callId of callIds) this.pendingToolCalls.add(callId);
		this.currentStatus = "waiting";
	}

	completeTool(callId: Identifier): void {
		this.assertStatus("waiting");
		if (!this.pendingToolCalls.delete(callId)) {
			throw new Error(`Tool call ${callId} is not pending`);
		}
		if (this.pendingToolCalls.size === 0) this.currentStatus = "running";
	}

	complete(at: string): void {
		this.assertActive();
		if (this.pendingToolCalls.size > 0) {
			throw new Error("A run cannot complete while tool calls are pending");
		}
		this.currentStatus = this.cancelWasRequested ? "cancelled" : "completed";
		this.endedAtValue = at;
	}

	cancel(at: string): void {
		this.assertActive();
		this.currentStatus = "cancelled";
		this.endedAtValue = at;
	}

	fail(message: string, at: string): void {
		this.assertActive();
		this.currentStatus = "failed";
		this.errorValue = message;
		this.endedAtValue = at;
	}

	toSnapshot(): RunSnapshot {
		return {
			id: this.id,
			conversationId: this.conversationId,
			status: this.currentStatus,
			cancelRequested: this.cancelWasRequested,
			queuedInputs: [...this.queuedInputs],
			pendingToolCallIds: [...this.pendingToolCalls],
			startedAt: this.startedAt,
			...(this.parentRunId === undefined ? {} : { parentRunId: this.parentRunId }),
			...(this.endedAtValue === undefined ? {} : { endedAt: this.endedAtValue }),
			...(this.errorValue === undefined ? {} : { error: this.errorValue }),
		};
	}

	static fromSnapshot(snapshot: RunSnapshot): AgentRun {
		const run = new AgentRun(
			snapshot.id,
			snapshot.conversationId,
			snapshot.startedAt,
			snapshot.parentRunId,
		);
		run.currentStatus = snapshot.status;
		run.cancelWasRequested = snapshot.cancelRequested;
		run.queuedInputs.push(...snapshot.queuedInputs);
		for (const callId of snapshot.pendingToolCallIds) run.pendingToolCalls.add(callId);
		run.endedAtValue = snapshot.endedAt;
		run.errorValue = snapshot.error;
		if (snapshot.status === "waiting" && run.pendingToolCalls.size === 0) {
			throw new Error(`Waiting run ${snapshot.id} has no pending tool calls`);
		}
		if (run.queuedInputs.some(({ message }) => message.runId !== snapshot.id || message.conversationId !== snapshot.conversationId)) {
			throw new Error(`Run ${snapshot.id} contains input from another run or conversation`);
		}
		return run;
	}

	private assertActive(): void {
		if (this.currentStatus === "completed" || this.currentStatus === "failed" || this.currentStatus === "cancelled") {
			throw new Error(`Run ${this.id} is already ${this.currentStatus}`);
		}
	}

	private assertStatus(expected: RunStatus): void {
		if (this.currentStatus !== expected) {
			throw new Error(`Run ${this.id} must be ${expected}; current status is ${this.currentStatus}`);
		}
	}
}
