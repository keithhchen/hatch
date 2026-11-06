import type { Pool, PoolClient } from "pg";
import { PersistenceError } from "../../domain/errors.js";
import type { RuntimeTransaction, RuntimeUnitOfWork } from "../../ports/runtime-ports.js";
import {
	createRecordRuntimeTransaction,
	type RuntimeRecord,
	type RuntimeRecordCollection,
	type TransactionalRecordStore,
} from "./RecordRuntimeRepositories.js";

const TABLES: Record<RuntimeRecordCollection, string> = {
	conversations: "agent_runtime_conversations",
	runs: "agent_runtime_runs",
	toolInvocations: "agent_runtime_tool_invocations",
};

export class PostgresRuntimeUnitOfWork implements RuntimeUnitOfWork {
	constructor(private readonly pool: Pool) {}

	async initialize(): Promise<void> {
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS agent_runtime_conversations (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_runtime_runs (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
			CREATE TABLE IF NOT EXISTS agent_runtime_tool_invocations (id TEXT PRIMARY KEY, payload JSONB NOT NULL);
		`);
	}

	async run<T>(work: (tx: RuntimeTransaction) => Promise<T>): Promise<T> {
		let client: PoolClient;
		try {
			client = await this.pool.connect();
		} catch (cause) {
			throw new PersistenceError("postgres", "Postgres could not acquire a transaction connection.", { cause });
		}
		try {
			try {
				await client.query("BEGIN");
			} catch (cause) {
				throw new PersistenceError("postgres", "Postgres could not begin a transaction.", { cause });
			}
			let result: T;
			try {
				result = await work(createRecordRuntimeTransaction(new PostgresRecordStore(client)));
			} catch (error) {
				await this.rollback(client, error);
				throw error;
			}
			try {
				await client.query("COMMIT");
			} catch (cause) {
				await this.rollback(client, cause);
				throw new PersistenceError("postgres", "Postgres could not commit a transaction.", { cause });
			}
			return result;
		} finally {
			client.release();
		}
	}

	private async rollback(client: PoolClient, originalError: unknown): Promise<void> {
		try {
			await client.query("ROLLBACK");
		} catch (rollbackError) {
			throw new AggregateError([originalError, rollbackError], "Postgres transaction and rollback both failed");
		}
	}
}

class PostgresRecordStore implements TransactionalRecordStore {
	constructor(private readonly client: PoolClient) {}

	async get(collection: RuntimeRecordCollection, id: string): Promise<string | undefined> {
		try {
			const result = await this.client.query<{ payload: string }>(`SELECT payload::text AS payload FROM ${TABLES[collection]} WHERE id = $1`, [id]);
			return result.rows[0]?.payload;
		} catch (cause) {
			throw new PersistenceError("postgres", "Postgres could not read a runtime record.", { cause });
		}
	}

	async insert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		try {
			await this.client.query(`INSERT INTO ${TABLES[collection]} (id, payload) VALUES ($1, $2::jsonb)`, [id, payload]);
		} catch (cause) {
			throw new PersistenceError("postgres", "Postgres could not insert a runtime record.", { cause });
		}
	}

	async upsert(collection: RuntimeRecordCollection, id: string, payload: string): Promise<void> {
		try {
			await this.client.query(
				`INSERT INTO ${TABLES[collection]} (id, payload) VALUES ($1, $2::jsonb) ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload`,
				[id, payload],
			);
		} catch (cause) {
			throw new PersistenceError("postgres", "Postgres could not save a runtime record.", { cause });
		}
	}

	async list(collection: RuntimeRecordCollection): Promise<RuntimeRecord[]> {
		try {
			const result = await this.client.query<RuntimeRecord>(`SELECT id, payload::text AS payload FROM ${TABLES[collection]} ORDER BY id`);
			return result.rows;
		} catch (cause) {
			throw new PersistenceError("postgres", "Postgres could not list runtime records.", { cause });
		}
	}
}
