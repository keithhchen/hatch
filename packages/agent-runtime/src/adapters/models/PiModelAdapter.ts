import type {
	AssistantMessageEvent,
	Api,
	Context as PiContext,
	Message as PiMessage,
	Model as PiModel,
	Provider,
	Tool as PiTool,
	JsonObject,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
	AssistantMessage,
	ContentBlock,
	Message,
	ModelContext,
	ModelEvent,
	ModelResponseMetadata,
	ToolCallBlock,
	ToolDefinition,
} from "../../domain/types.js";
import { ModelProviderError } from "../../domain/errors.js";
import type { Model } from "../../ports/runtime-ports.js";

export interface PiModelAdapterOptions {
	apiKey: string;
	model: string;
	maxTokens?: number;
	temperature?: number;
	timeoutMs?: number;
	maxRetries?: number;
	reasoning?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export abstract class PiModelAdapter implements Model {
	private readonly provider: Provider;
	private readonly model: PiModel<Api>;

	protected constructor(
		private readonly providerName: string,
		provider: Provider,
		private readonly options: PiModelAdapterOptions,
	) {
		if (options.apiKey.trim().length === 0) {
			throw new Error(`${providerName} API key must not be empty`);
		}
		this.provider = provider;
		const model = provider.getModels().find((candidate) => candidate.id === options.model);
		if (model === undefined) {
			throw new Error(`Model ${options.model} is not available from ${providerName}`);
		}
		this.model = model;
	}

	async *stream(context: ModelContext, signal: AbortSignal): AsyncIterable<ModelEvent> {
		const piContext = normalizeContext(toPiContext(context));
		const stream = this.provider.streamSimple(this.model, piContext, {
			apiKey: this.options.apiKey,
			signal,
			...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }),
			...(this.options.temperature === undefined ? {} : { temperature: this.options.temperature }),
			...(this.options.timeoutMs === undefined ? {} : { timeoutMs: this.options.timeoutMs }),
			...(this.options.maxRetries === undefined ? {} : { maxRetries: this.options.maxRetries }),
			...(this.options.reasoning === undefined ? {} : { reasoning: this.options.reasoning }),
		});

		try {
			for await (const event of stream) yield* this.mapEvent(event, signal);
		} catch (cause) {
			if (signal.aborted) throw signal.reason ?? cause;
			throw new ModelProviderError(this.providerName, "The model provider request failed.", false, { cause });
		}
	}

	private *mapEvent(event: AssistantMessageEvent, signal: AbortSignal): Iterable<ModelEvent> {
		switch (event.type) {
			case "text_delta":
				yield { type: "text_delta", text: event.delta };
				return;
			case "thinking_delta":
				yield { type: "thinking_delta", thinking: event.delta };
				return;
			case "toolcall_end":
				yield { type: "tool_call", call: fromPiToolCall(event.toolCall, this.model.provider) };
				return;
			case "done":
				for (const block of event.message.content) {
					if (block.type === "thinking" && block.thinkingSignature !== undefined) {
						yield { type: "thinking_signature", signature: block.thinkingSignature };
					}
				}
				yield { type: "turn_complete", metadata: responseMetadata(event.message, event.reason) };
				return;
			case "error":
				if (event.reason === "aborted" || signal.aborted) throw signal.reason ?? new Error("Model request was aborted");
				throw new ModelProviderError(
					this.providerName,
					"The model provider could not complete the request.",
					false,
					{ cause: event.error },
				);
			default:
				return;
		}
	}
}

function toPiContext(context: ModelContext): PiContext {
	const systemMessages = context.messages.filter((message) => message.role === "system");
	if (systemMessages.length > 1) throw new Error("Model context may contain only one system message");
	const systemPrompt = systemMessages[0]?.content;
	const messages = context.messages.filter((message) => message.role !== "system").map(toPiMessage);
	const tools = context.tools.map(toPiTool);
	return {
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		messages,
		...(tools.length === 0 ? {} : { tools }),
	};
}

function toPiMessage(message: Exclude<ModelContext["messages"][number], { role: "system" }>): PiMessage {
	if (message.role === "user") {
		return {
			role: "user",
			content: message.content.map((block) => block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image", data: block.data, mimeType: block.mimeType }),
			timestamp: Date.parse(message.createdAt),
		};
	}
	if (message.role === "toolResult") {
		return {
			role: "toolResult",
			toolCallId: message.callId,
			toolName: message.name,
			content: message.content.map((block) => block.type === "text"
				? { type: "text", text: block.text }
				: { type: "image", data: block.data, mimeType: block.mimeType }),
			isError: message.isError,
			timestamp: Date.parse(message.createdAt),
		};
	}
	return toPiAssistantMessage(message);
}

function toPiAssistantMessage(message: AssistantMessage): PiMessage {
	const content = message.content.map((block) => {
		if (block.type === "image") throw new Error("Pi assistant history does not support image output blocks");
		return toPiContentBlock(block);
	});
	const metadata = message.model;
	if (metadata === undefined) {
		throw new Error(`Assistant message ${message.id} has no model response metadata`);
	}
	return {
		role: "assistant",
		content,
		api: metadata.api,
		provider: metadata.provider,
		model: metadata.model,
		usage: {
			input: metadata.usage?.inputTokens ?? 0,
			output: metadata.usage?.outputTokens ?? 0,
			cacheRead: metadata.usage?.cacheReadTokens ?? 0,
			cacheWrite: metadata.usage?.cacheWriteTokens ?? 0,
			totalTokens: metadata.usage?.totalTokens ?? 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: metadata.stopReason,
		timestamp: Date.parse(message.createdAt),
		...(metadata.responseId === undefined ? {} : { responseId: metadata.responseId }),
	};
}

function toPiContentBlock(block: Exclude<ContentBlock, { type: "image" }>) {
	switch (block.type) {
		case "text":
			return { type: "text", text: block.text } as const;
		case "thinking":
			return {
				type: "thinking",
				thinking: block.thinking,
				...(block.signature === undefined ? {} : { thinkingSignature: block.signature }),
			} as const;
		case "toolCall":
			const thoughtSignature = providerThoughtSignature(block);
			return {
				type: "toolCall",
				id: block.callId,
				name: block.name,
				arguments: asJsonObject(block.arguments, `arguments for tool ${block.name}`),
				...(thoughtSignature === undefined ? {} : { thoughtSignature }),
			} as const;
	}
}

function toPiTool(definition: ToolDefinition): PiTool {
	return {
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters as PiTool["parameters"],
	};
}

function fromPiToolCall(
	call: { id: string; name: string; arguments: Record<string, unknown>; thoughtSignature?: string },
	provider: string,
): ToolCallBlock {
	return {
		type: "toolCall",
		callId: call.id,
		name: call.name,
		arguments: call.arguments,
		...(call.thoughtSignature === undefined
			? {}
			: { providerMetadata: { provider, value: { thoughtSignature: call.thoughtSignature } } }),
	};
}

function providerThoughtSignature(block: ToolCallBlock): string | undefined {
	if (block.providerMetadata?.provider !== "google") return undefined;
	const value = block.providerMetadata.value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const signature = (value as Record<string, unknown>).thoughtSignature;
	return typeof signature === "string" ? signature : undefined;
}

function responseMetadata(
	message: Extract<PiMessage, { role: "assistant" }>,
	stopReason: ModelResponseMetadata["stopReason"],
): ModelResponseMetadata {
	return {
		api: message.api,
		provider: message.provider,
		model: message.model,
		stopReason,
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		usage: {
			inputTokens: message.usage.input,
			outputTokens: message.usage.output,
			totalTokens: message.usage.totalTokens,
			cacheReadTokens: message.usage.cacheRead,
			cacheWriteTokens: message.usage.cacheWrite,
		},
	};
}

function asJsonObject(value: unknown, description: string): JsonObject {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`${description} must be a JSON object`);
	}
	let encoded: string | undefined;
	try {
		encoded = JSON.stringify(value);
	} catch (cause) {
		throw new TypeError(`${description} must contain only JSON values`, { cause });
	}
	if (encoded === undefined) throw new TypeError(`${description} must contain only JSON values`);
	const normalized: unknown = JSON.parse(encoded);
	if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) {
		throw new TypeError(`${description} must be a JSON object`);
	}
	return normalized as JsonObject;
}
