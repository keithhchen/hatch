import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntime, ToolSet } from "../dist/index.js";
import { KimiModelAdapter, GeminiModelAdapter } from "../dist/adapters/models/index.js";
import { SqliteRuntimeUnitOfWork } from "../dist/adapters/persistence/index.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataRoot = path.join(packageRoot, ".test-data");
await mkdir(dataRoot, { recursive: true });
const dataDirectory = await mkdtemp(path.join(dataRoot, "provider-runtime-"));
const databasePath = path.join(dataDirectory, "runtime.sqlite");
let unitOfWork = SqliteRuntimeUnitOfWork.open(databasePath);

class ConversationContextBuilder {
	async build(conversation, _run, availableTools) {
		return {
			context: {
				messages: [
					{ role: "system", content: "You are a concise assistant. Follow the latest user request." },
					...conversation.messages,
				],
				tools: availableTools,
			},
			compactions: [],
		};
	}
}

class ConsoleEventPublisher {
	types = [];

	async publish(event) {
		this.types.push(event.type);
	}
}

try {
	const verifiedRuns = [];
	verifiedRuns.push(await verifyProvider("kimi", new KimiModelAdapter({
		apiKey: requiredEnvironment("LLM_API_KEY"),
		maxTokens: 512,
		reasoning: "minimal",
	})));
	verifiedRuns.push(await verifyProvider("gemini", new GeminiModelAdapter({
		apiKey: requiredEnvironment("GEMINI_API_KEY"),
		maxTokens: 256,
		reasoning: "low",
	})));
	unitOfWork.close();
	unitOfWork = SqliteRuntimeUnitOfWork.open(databasePath);
	for (const { providerName, conversationId, runId } of verifiedRuns) {
		const persisted = await unitOfWork.run(async (tx) => ({
			conversation: await tx.conversations.find(conversationId),
			run: await tx.runs.find(runId),
		}));
		assert.equal(persisted.run?.toSnapshot().status, "completed", `${providerName} run should survive reopening`);
		assert.ok(persisted.conversation?.messages.some((message) => message.role === "assistant"));
	}
	console.log("SQLite records remain readable after reopening the database.");
} finally {
	unitOfWork.close();
	await rm(dataDirectory, { recursive: true, force: true });
}

async function verifyProvider(name, model) {
	const conversationId = `${name}-${randomUUID()}`;
	const publishedEvents = new ConsoleEventPublisher();
	const runtime = new AgentRuntime({
		unitOfWork,
		events: publishedEvents,
		identifiers: { create: () => randomUUID() },
		clock: { now: () => new Date().toISOString() },
	});
	const session = {
		model,
		contextBuilder: new ConversationContextBuilder(),
		toolRegistry: new ToolSet([]),
	};
	const handle = await runtime.start(session, {
		conversationId,
		content: [{ type: "text", text: "Reply with the single word OK." }],
	});
	await handle.completion;

	const persisted = await unitOfWork.run(async (tx) => ({
		conversation: await tx.conversations.find(conversationId),
		run: await tx.runs.find(handle.runId),
	}));
	assert.equal(persisted.run?.toSnapshot().status, "completed", `${name} run should complete`);
	assert.ok(
		persisted.conversation?.messages.some((message) =>
			message.role === "assistant" && message.content.some((block) => block.type === "text" && block.text.length > 0)),
		`${name} assistant response should be persisted`,
	);
	assert.ok(publishedEvents.types.includes("message_delta"), `${name} should publish streaming deltas`);
	assert.ok(publishedEvents.types.includes("run_completed"), `${name} should publish run completion`);
	const assistant = persisted.conversation.messages.findLast((message) => message.role === "assistant");
	console.log(JSON.stringify({
		provider: name,
		status: persisted.run.toSnapshot().status,
		model: assistant.model?.model,
		streamDeltaCount: publishedEvents.types.filter((type) => type === "message_delta").length,
		completedEvent: publishedEvents.types.includes("run_completed"),
		assistantTextPersisted: assistant.content.some((block) => block.type === "text" && block.text.length > 0),
	}));
	return { providerName: name, conversationId, runId: handle.runId };
}

function requiredEnvironment(name) {
	const value = process.env[name];
	if (value === undefined || value.trim().length === 0) throw new Error(`${name} is required`);
	return value;
}
