import type { AssistantMessage } from "../domain/types.js";
import type { RunExecution } from "./RunExecution.js";
import type { ModelTurnResult } from "./ModelTurn.js";

export interface RunPhase {
	advance(execution: RunExecution): Promise<RunPhase | undefined>;
}

export class RequestModelPhase implements RunPhase {
	async advance(execution: RunExecution): Promise<RunPhase | undefined> {
		if (execution.cancelRequested) return new CancelRunPhase();
		const result = await execution.requestModelTurn();
		if (execution.cancelRequested) return new CancelRunPhase();
		return result.toolCalls.length > 0
			? new ExecuteToolsPhase(result)
			: new AppendAssistantPhase(result.message);
	}
}

export class ExecuteToolsPhase implements RunPhase {
	constructor(private readonly result: ModelTurnResult) {}

	async advance(execution: RunExecution): Promise<RunPhase | undefined> {
		await execution.executeTools(this.result);
		return execution.cancelRequested ? new CancelRunPhase() : new RequestModelPhase();
	}
}

export class AppendAssistantPhase implements RunPhase {
	constructor(private readonly message: AssistantMessage) {}

	async advance(execution: RunExecution): Promise<RunPhase | undefined> {
		if (execution.cancelRequested) return new CancelRunPhase();
		if (await execution.appendAssistantAndQueuedInputs(this.message)) return new RequestModelPhase();
		await execution.completeRun();
		return undefined;
	}
}

export class CancelRunPhase implements RunPhase {
	async advance(execution: RunExecution): Promise<RunPhase | undefined> {
		await execution.finishCancelled();
		return undefined;
	}
}
