import type { CompactionRecord, ConversationSnapshot, Identifier, Message } from "./types.js";

export class Conversation {
	private readonly history: Message[];
	private readonly compactionHistory: CompactionRecord[];

	constructor(
		readonly id: Identifier,
		readonly createdAt: string,
		messages: Message[] = [],
		compactions: CompactionRecord[] = [],
	) {
		this.history = [...messages];
		this.compactionHistory = [...compactions];
	}

	get messages(): readonly Message[] {
		return this.history;
	}

	get compactions(): readonly CompactionRecord[] {
		return this.compactionHistory;
	}

	append(message: Message): void {
		if (message.conversationId !== this.id) {
			throw new Error("Message belongs to another conversation");
		}
		this.history.push(message);
	}

	appendCompaction(record: CompactionRecord): void {
		if (record.conversationId !== this.id) throw new Error("Compaction belongs to another conversation");
		this.compactionHistory.push(record);
	}

	toSnapshot(): ConversationSnapshot {
		return {
			id: this.id,
			createdAt: this.createdAt,
			messages: [...this.history],
			compactions: [...this.compactionHistory],
		};
	}

	static fromSnapshot(snapshot: ConversationSnapshot): Conversation {
		return new Conversation(snapshot.id, snapshot.createdAt, snapshot.messages, snapshot.compactions);
	}
}
