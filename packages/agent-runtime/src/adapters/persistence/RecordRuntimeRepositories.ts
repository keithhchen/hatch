import { AgentRun } from "../../domain/AgentRun.js";
import { Conversation } from "../../domain/Conversation.js";
import { ToolInvocation } from "../../domain/ToolInvocation.js";
import type {
	CompactionRecord,
	ConversationSnapshot,
	Identifier,
	Message,
	RunSnapshot,
	ToolInvocationSnapshot,
} from "../../domain/types.js";
import { PersistenceError } from "../../domain/errors.js";
import type { RuntimeTransaction } from "../../ports/runtime-ports.js";

export type RuntimeRecordCollection = "conversations" | "runs" | "toolInvocations";

export interface RuntimeRecord {
	id: Identifier;
	payload: string;
}

export interface TransactionalRecordStore {
	get(collection: RuntimeRecordCollection, id: Identifier): Promise<string | undefined>;
	insert(collection: RuntimeRecordCollection, id: Identifier, payload: string): Promise<void>;
	upsert(collection: RuntimeRecordCollection, id: Identifier, payload: string): Promise<void>;
	list(collection: RuntimeRecordCollection): Promise<RuntimeRecord[]>;
}

export function createRecordRuntimeTransaction(records: TransactionalRecordStore): RuntimeTransaction {
	return {
		conversations: {
			find: async (id) => {
				const payload = await records.get("conversations", id);
				return payload === undefined ? undefined : Conversation.fromSnapshot(parsePayload<ConversationSnapshot>(payload));
			},
			add: async (conversation) => {
				await records.insert("conversations", conversation.id, JSON.stringify(conversation.toSnapshot()));
			},
			append: async (conversationId, message: Message) => {
				const conversation = await requireConversation(records, conversationId);
				conversation.append(message);
				await records.upsert("conversations", conversationId, JSON.stringify(conversation.toSnapshot()));
			},
			appendCompaction: async (record: CompactionRecord) => {
				const conversation = await requireConversation(records, record.conversationId);
				conversation.appendCompaction(record);
				await records.upsert("conversations", record.conversationId, JSON.stringify(conversation.toSnapshot()));
			},
			list: async () => (await records.list("conversations")).map(({ payload }) => parsePayload<ConversationSnapshot>(payload)),
		},
		runs: {
			find: async (id) => {
				const payload = await records.get("runs", id);
				return payload === undefined ? undefined : AgentRun.fromSnapshot(parsePayload<RunSnapshot>(payload));
			},
			add: async (run) => {
				await records.insert("runs", run.id, JSON.stringify(run.toSnapshot()));
			},
			save: async (run) => {
				await records.upsert("runs", run.id, JSON.stringify(run.toSnapshot()));
			},
		},
		toolInvocations: {
			find: async (callId) => {
				const payload = await records.get("toolInvocations", callId);
				return payload === undefined ? undefined : ToolInvocation.fromSnapshot(parsePayload<ToolInvocationSnapshot>(payload));
			},
			listForRun: async (runId) => (await records.list("toolInvocations"))
				.map(({ payload }) => ToolInvocation.fromSnapshot(parsePayload<ToolInvocationSnapshot>(payload)))
				.filter((invocation) => invocation.runId === runId),
			add: async (invocation) => {
				await records.insert("toolInvocations", invocation.callId, JSON.stringify(invocation.toSnapshot()));
			},
			save: async (invocation) => {
				await records.upsert("toolInvocations", invocation.callId, JSON.stringify(invocation.toSnapshot()));
			},
		},
	};
}

async function requireConversation(records: TransactionalRecordStore, id: Identifier): Promise<Conversation> {
	const payload = await records.get("conversations", id);
	if (payload === undefined) throw new PersistenceError("runtime", `Conversation ${id} does not exist`);
	return Conversation.fromSnapshot(parsePayload<ConversationSnapshot>(payload));
}

function parsePayload<T>(payload: string): T {
	return JSON.parse(payload) as T;
}
