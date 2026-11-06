import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { PersistenceError } from "../../domain/errors.js";
import type { RuntimeTransaction, RuntimeUnitOfWork } from "../../ports/runtime-ports.js";
import {
	createRecordRuntimeTransaction,
	type RuntimeRecord,
	type RuntimeRecordCollection,
	type TransactionalRecordStore,
} from "./RecordRuntimeRepositories.js";
import { SerialTransactionGate } from "./SerialTransactionGate.js";

interface PersistedRecord extends RuntimeRecord {
	collection: RuntimeRecordCollection;
}

type RuntimeRecords = Record<RuntimeRecordCollection, Map<string, string>>;

const COLLECTIONS: RuntimeRecordCollection[] = ["conversations", "runs", "toolInvocations"];

export class JsonlRuntimeUnitOfWork implements RuntimeUnitOfWork {
	private readonly gate = new SerialTransactionGate();

	private constructor(private readonly filename: string, private records: RuntimeRecords) {}

	static async open(filename: string): Promise<JsonlRuntimeUnitOfWork> {
		await mkdir(dirname(filename), { recursive: true });
		const createdFile = await open(filename, "a");
		await createdFile.close();
		const records = decodeRecords(await readFile(filename, "utf8"));
		return new JsonlRuntimeUnitOfWork(filename, records);
	}

	run<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
		return this.gate.run(async () => {
			const draft = cloneRecords(this.records);
			const result = await work(createRecordRuntimeTransaction(new JsonlRecordStore(draft)));
			await this.replaceFile(draft);
			return result;
		});
	}

	private async replaceFile(records: RuntimeRecords): Promise<void> {
		const temporary = `${this.filename}.${randomUUID()}.pending`;
		const content = encodeRecords(records);
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(content, "utf8");
			await file.sync();
		} catch (cause) {
			throw new PersistenceError("jsonl", "JSONL storage could not write a transaction.", { cause });
		} finally {
			await file.close();
		}
		try {
			await rename(temporary, this.filename);
			this.records = records;
			const directory = await open(dirname(this.filename), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} catch (cause) {
			throw new PersistenceError("jsonl", "JSONL storage could not commit a transaction.", { cause });
		} finally {
			await rm(temporary, { force: true });
		}
	}
}

class JsonlRecordStore implements TransactionalRecordStore {
	constructor(private readonly records: RuntimeRecords) {}

	async get(collection: RuntimeRecordCollection, id: string): Promise<string | undefined> {
		return this.records[collection].get(id);
	}

	async insert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		if (this.records[collection].has(id)) throw new PersistenceError("jsonl", `Duplicate ${collection} record ${id}`);
		this.records[collection].set(id, payload);
	}

	async upsert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		this.records[collection].set(id, payload);
	}

	async list(collection: RuntimeRecordCollection): Promise<RuntimeRecord[]> {
		return [...this.records[collection]]
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([id, payload]) => ({ id, payload }));
	}
}

function emptyRecords(): RuntimeRecords {
	return { conversations: new Map(), runs: new Map(), toolInvocations: new Map() };
}

function cloneRecords(records: RuntimeRecords): RuntimeRecords {
	return {
		conversations: new Map(records.conversations),
		runs: new Map(records.runs),
		toolInvocations: new Map(records.toolInvocations),
	};
}

function encodeRecords(records: RuntimeRecords): string {
	const lines: string[] = [];
	for (const collection of COLLECTIONS) {
		for (const [id, payload] of [...records[collection]].sort(([left], [right]) => left.localeCompare(right))) {
			lines.push(JSON.stringify({ collection, id, payload } satisfies PersistedRecord));
		}
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function decodeRecords(content: string): RuntimeRecords {
	const records = emptyRecords();
	for (const line of content.split(/\r?\n/).filter((entry) => entry.length > 0)) {
		let record: PersistedRecord;
		try {
			record = JSON.parse(line) as PersistedRecord;
		} catch (cause) {
			throw new PersistenceError("jsonl", "JSONL storage contains an invalid JSON record.", { cause });
		}
		if (!COLLECTIONS.includes(record.collection) || typeof record.id !== "string" || typeof record.payload !== "string") {
			throw new PersistenceError("jsonl", "JSONL storage contains an invalid runtime record");
		}
		if (records[record.collection].has(record.id)) {
			throw new PersistenceError("jsonl", `JSONL storage contains duplicate ${record.collection} record ${record.id}`);
		}
		records[record.collection].set(record.id, record.payload);
	}
	return records;
}
