import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PersistenceError } from "../../domain/errors.js";
import type { RuntimeTransaction, RuntimeUnitOfWork } from "../../ports/runtime-ports.js";
import {
	createRecordRuntimeTransaction,
	type RuntimeRecord,
	type RuntimeRecordCollection,
	type TransactionalRecordStore,
} from "./RecordRuntimeRepositories.js";
import { SerialTransactionGate } from "./SerialTransactionGate.js";

const TABLES: Record<RuntimeRecordCollection, string> = {
	conversations: "agent_runtime_conversations",
	runs: "agent_runtime_runs",
	toolInvocations: "agent_runtime_tool_invocations",
};

export class SqliteRuntimeUnitOfWork implements RuntimeUnitOfWork {
	private readonly gate = new SerialTransactionGate();

	constructor(private readonly database: DatabaseSync) {
		database.exec(`
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS agent_runtime_conversations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_runtime_runs (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_runtime_tool_invocations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);
		`);
	}

	static open(filename: string): SqliteRuntimeUnitOfWork {
		if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
		return new SqliteRuntimeUnitOfWork(new DatabaseSync(filename));
	}

	run<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
		return this.gate.run(async () => {
			try {
				this.database.exec("BEGIN IMMEDIATE");
			} catch (cause) {
				throw new PersistenceError("sqlite", "SQLite could not begin a transaction.", { cause });
			}
			let result: T;
			try {
				result = await work(createRecordRuntimeTransaction(new SqliteRecordStore(this.database)));
			} catch (error) {
				this.rollback(error);
				throw error;
			}
			try {
				this.database.exec("COMMIT");
			} catch (cause) {
				this.rollback(cause);
				throw new PersistenceError("sqlite", "SQLite could not commit a transaction.", { cause });
			}
			return result;
		});
	}

	close(): void {
		this.database.close();
	}

	private rollback(originalError: unknown): void {
		try {
			this.database.exec("ROLLBACK");
		} catch (rollbackError) {
			throw new AggregateError([originalError, rollbackError], "SQLite transaction and rollback both failed");
		}
	}
}

class SqliteRecordStore implements TransactionalRecordStore {
	constructor(private readonly database: DatabaseSync) {}

	async get(collection: RuntimeRecordCollection, id: string): Promise<string | undefined> {
		try {
			const row = this.database.prepare(`SELECT payload FROM ${TABLES[collection]} WHERE id = ?`).get(id) as { payload: string } | undefined;
			return row?.payload;
		} catch (cause) {
			throw new PersistenceError("sqlite", "SQLite could not read a runtime record.", { cause });
		}
	}

	async insert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		try {
			this.database.prepare(`INSERT INTO ${TABLES[collection]} (id, payload) VALUES (?, ?)`).run(id, payload);
		} catch (cause) {
			throw new PersistenceError("sqlite", "SQLite could not insert a runtime record.", { cause });
		}
	}

	async upsert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		try {
			this.database.prepare(`INSERT INTO ${TABLES[collection]} (id, payload) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload`).run(id, payload);
		} catch (cause) {
			throw new PersistenceError("sqlite", "SQLite could not save a runtime record.", { cause });
		}
	}

	async list(collection: RuntimeRecordCollection): Promise<RuntimeRecord[]> {
		try {
			return this.database.prepare(`SELECT id, payload FROM ${TABLES[collection]} ORDER BY id`).all() as unknown as RuntimeRecord[];
		} catch (cause) {
			throw new PersistenceError("sqlite", "SQLite could not list runtime records.", { cause });
		}
	}
}
