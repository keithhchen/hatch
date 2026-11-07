import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { Pool } from "pg";
import { AgentRun, Conversation, ToolInvocation } from "../dist/index.js";
import {
	JsonlRuntimeUnitOfWork,
	PostgresRuntimeUnitOfWork,
	SqliteRuntimeUnitOfWork,
} from "../dist/adapters/persistence/index.js";

const dataRoot = path.join(process.cwd(), ".test-data");

test("JSONL and SQLite UnitOfWork commit shared repositories, return T, reload, and roll back errors", async () => {
	await mkdir(dataRoot, { recursive: true });
	const directory = await mkdtemp(path.join(dataRoot, "persistence-"));
	try {
		await verifyUnitOfWork(
			() => JsonlRuntimeUnitOfWork.open(path.join(directory, "runtime.jsonl")),
			(store) => store,
			undefined,
			undefined,
			() => JsonlRuntimeUnitOfWork.open(path.join(directory, "runtime.jsonl")),
		);
		await verifyUnitOfWork(
			() => SqliteRuntimeUnitOfWork.open(path.join(directory, "runtime.sqlite")),
			(store) => store,
			(store) => store.close(),
			undefined,
			() => SqliteRuntimeUnitOfWork.open(path.join(directory, "runtime.sqlite")),
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("Postgres UnitOfWork uses the configured database when available", async (context) => {
	const connectionString = process.env.AGENT_RUNTIME_POSTGRES_URL;
	if (!connectionString) {
		context.skip("AGENT_RUNTIME_POSTGRES_URL is not configured");
		return;
	}

	const pool = new Pool({ connectionString });
	const store = new PostgresRuntimeUnitOfWork(pool);
	const runId = `persistence-test-${randomUUID()}`;
	const conversationId = `persistence-test-${randomUUID()}`;
	const callId = `persistence-test-${randomUUID()}`;
	try {
		await store.initialize();
		await verifyUnitOfWork(
			async () => store,
			(value) => value,
			async () => {
				await pool.query("DELETE FROM agent_runtime_tool_invocations WHERE id = $1", [callId]);
				await pool.query("DELETE FROM agent_runtime_runs WHERE id = $1", [runId]);
				await pool.query("DELETE FROM agent_runtime_conversations WHERE id = $1", [conversationId]);
			},
			{ runId, conversationId, callId },
		);
	} finally {
		await pool.end();
	}
});

async function verifyUnitOfWork(openStore, closeStore, cleanup, ids = {}, reopenStore) {
	let store = await openStore();
	const suffix = randomUUID();
	const conversationId = ids.conversationId ?? `conversation-${suffix}`;
	const runId = ids.runId ?? `run-${suffix}`;
	const callId = ids.callId ?? `call-${suffix}`;
	const createdAt = new Date().toISOString();
	const conversation = new Conversation(conversationId, createdAt);
	const run = new AgentRun(runId, conversationId, createdAt);
	run.waitForTools([callId]);
	const invocation = new ToolInvocation(callId, runId, "inspect");
	const message = {
		id: `message-${suffix}`,
		conversationId,
		runId,
		role: "user",
		content: [{ type: "text", text: "persist this" }],
		createdAt,
	};
	conversation.append(message);
	const queuedMessage = {
		...message,
		id: `queued-${suffix}`,
		content: [{ type: "text", text: "follow up" }],
	};
	run.queueInput(queuedMessage, "followUp");
	const compaction = {
		conversationId,
		runId,
		summary: "Earlier messages",
		firstKeptMessageId: message.id,
		createdAt,
	};

	try {
		const returned = await store.run(async (tx) => {
			await tx.conversations.add(conversation);
			await tx.conversations.appendCompaction(compaction);
			await tx.runs.add(run);
			await tx.toolInvocations.add(invocation);
			return { runId, conversationId };
		});
		assert.deepEqual(returned, { runId, conversationId });
		if (reopenStore) {
			await closeStore?.(store);
			store = await reopenStore();
		}

		await store.run(async (tx) => {
			const restoredConversation = await tx.conversations.find(conversationId);
			const restoredRun = await tx.runs.find(runId);
			const restoredInvocation = await tx.toolInvocations.find(callId);
			assert.deepEqual(restoredConversation?.messages, [message]);
			assert.deepEqual(restoredConversation?.compactions, [compaction]);
			assert.equal(restoredRun?.toSnapshot().id, runId);
			assert.deepEqual(restoredRun?.toSnapshot().pendingToolCallIds, [callId]);
			assert.deepEqual(restoredRun?.toSnapshot().queuedInputs, [{ message: queuedMessage, mode: "followUp" }]);
			assert.equal(restoredInvocation?.status, "running");
		});

		const rollbackConversationId = `rollback-${suffix}`;
		await assert.rejects(store.run(async (tx) => {
			await tx.conversations.add(new Conversation(rollbackConversationId, createdAt));
			throw new Error("transaction must roll back");
		}), /transaction must roll back/);
		await store.run(async (tx) => {
			assert.equal(await tx.conversations.find(rollbackConversationId), undefined);
		});
	} finally {
		await closeStore?.(store);
		await cleanup?.(store);
	}
}
