export type RuntimeErrorBoundary = "model" | "context" | "compaction" | "persistence" | "event";

export class RuntimeError extends Error {
	constructor(
		readonly boundary: RuntimeErrorBoundary,
		readonly code: string,
		message: string,
	readonly retryable: boolean,
	options?: ErrorOptions,
	) {
		super(message, options);
		this.name = new.target.name;
	}
}

export class ModelProviderError extends RuntimeError {
	constructor(provider: string, message: string, retryable: boolean, options?: ErrorOptions) {
		super("model", `${provider}_provider_error`, message, retryable, options);
	}
}

export class PersistenceError extends RuntimeError {
	constructor(adapter: string, message: string, options?: ErrorOptions) {
		super("persistence", `${adapter}_persistence_error`, message, false, options);
	}
}
