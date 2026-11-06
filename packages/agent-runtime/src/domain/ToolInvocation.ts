import type { Identifier, ToolInvocationSnapshot, ToolInvocationStatus } from "./types.js";

export class ToolInvocation {
	private currentStatus: ToolInvocationStatus = "running";

	constructor(
		readonly callId: Identifier,
		readonly runId: Identifier,
		readonly toolName: string,
	) {}

	get status(): ToolInvocationStatus {
		return this.currentStatus;
	}

	complete(): void {
		this.assertRunning();
		this.currentStatus = "completed";
	}

	fail(): void {
		if (this.currentStatus === "completed" || this.currentStatus === "cancelled") {
			throw new Error(`Tool call ${this.callId} is already ${this.currentStatus}`);
		}
		this.currentStatus = "failed";
	}

	cancel(): void {
		if (this.currentStatus === "completed" || this.currentStatus === "failed") {
			throw new Error(`Tool call ${this.callId} is already ${this.currentStatus}`);
		}
		this.currentStatus = "cancelled";
	}

	toSnapshot(): ToolInvocationSnapshot {
		return {
			callId: this.callId,
			runId: this.runId,
			toolName: this.toolName,
			status: this.currentStatus,
		};
	}

	static fromSnapshot(snapshot: ToolInvocationSnapshot): ToolInvocation {
		const invocation = new ToolInvocation(snapshot.callId, snapshot.runId, snapshot.toolName);
		invocation.currentStatus = snapshot.status;
		return invocation;
	}

	private assertRunning(): void {
		if (this.currentStatus !== "running") {
			throw new Error(`Tool call ${this.callId} must be running`);
		}
	}

}
