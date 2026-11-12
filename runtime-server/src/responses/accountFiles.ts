import { randomBytes } from "node:crypto";
import type { PostgresQueryExecutor } from "../postgresStore.js";

/** A file an account uploaded through the Files API, not yet (or not only) part of any conversation. */
export type AccountFile = { id: string; accountId: string; filename: string; purpose: string; bytes: number; createdAt: Date };

export const DEFAULT_ACCOUNT_FILES_QUOTA_BYTES = 500 * 1024 * 1024;

/** The account's files already hold `used` of its `quota` bytes: the new file does not fit. */
export class StorageQuotaExceeded extends Error {
  constructor(readonly used: number, readonly quota: number) { super("Account file storage quota exceeded."); this.name = "StorageQuotaExceeded"; }
}

/** Where the Files API keeps an account's files. Every call is scoped to the account, so another account's id is simply absent. */
export interface AccountFiles {
  /** Stores the file unless the account's total would pass its quota (StorageQuotaExceeded), however many uploads race. */
  put(accountId: string, input: { filename: string; purpose: string; content: Buffer }): Promise<AccountFile>;
  get(accountId: string, id: string): Promise<AccountFile | undefined>;
  content(accountId: string, id: string): Promise<Buffer | undefined>;
  /** Newest first. */
  list(accountId: string): Promise<AccountFile[]>;
  delete(accountId: string, id: string): Promise<boolean>;
}

const newId = (): string => `file_${randomBytes(12).toString("hex")}`;

export class InMemoryAccountFiles implements AccountFiles {
  private readonly rows = new Map<string, { file: AccountFile; content: Buffer }>();
  constructor(private readonly quotaBytes = DEFAULT_ACCOUNT_FILES_QUOTA_BYTES) {}

  async put(accountId: string, input: { filename: string; purpose: string; content: Buffer }): Promise<AccountFile> {
    const used = (await this.list(accountId)).reduce((sum, file) => sum + file.bytes, 0);
    if (used + input.content.length > this.quotaBytes) throw new StorageQuotaExceeded(used, this.quotaBytes);
    const file = { id: newId(), accountId, filename: input.filename, purpose: input.purpose, bytes: input.content.length, createdAt: new Date() };
    this.rows.set(file.id, { file, content: input.content });
    return file;
  }
  async get(accountId: string, id: string) { const row = this.rows.get(id); return row?.file.accountId === accountId ? row.file : undefined; }
  async content(accountId: string, id: string) { const row = this.rows.get(id); return row?.file.accountId === accountId ? row.content : undefined; }
  async list(accountId: string) { return [...this.rows.values()].map((row) => row.file).filter((file) => file.accountId === accountId).reverse(); }
  async delete(accountId: string, id: string) { return (await this.get(accountId, id)) ? this.rows.delete(id) : false; }
}

/** Additive: one table, created if absent. Bytes live in the row; a file is at most the 50 MB the asset pipeline accepts. */
export const POSTGRES_ACCOUNT_FILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hatch_account_files (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  filename text NOT NULL,
  purpose text NOT NULL,
  bytes integer NOT NULL,
  content bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hatch_account_files_account ON hatch_account_files (account_id, created_at DESC);
`;

type Row = { id: string; account_id: string; filename: string; purpose: string; bytes: number; created_at: Date };
const COLUMNS = "id, account_id, filename, purpose, bytes, created_at";
const fileOf = (row: Row): AccountFile => ({ id: row.id, accountId: row.account_id, filename: row.filename, purpose: row.purpose, bytes: row.bytes, createdAt: row.created_at });

type Transactional = PostgresQueryExecutor & { connect?: () => Promise<PostgresQueryExecutor & { release(error?: Error): void }> };

export class PostgresAccountFiles implements AccountFiles {
  constructor(private readonly db: Transactional, private readonly quotaBytes = DEFAULT_ACCOUNT_FILES_QUOTA_BYTES) {}

  initialize() { return this.db.query(POSTGRES_ACCOUNT_FILES_SCHEMA); }

  /** One transaction per upload, serialized per account by an advisory lock, so the sum it checks is the sum it adds to. */
  async put(accountId: string, input: { filename: string; purpose: string; content: Buffer }): Promise<AccountFile> {
    if (!this.db.connect) throw new Error("Account files need a pool that can run transactions.");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`hatch_account_files:${accountId}`]);
      const { rows: [total] } = await client.query<{ used: string }>(`SELECT COALESCE(SUM(bytes), 0) AS used FROM hatch_account_files WHERE account_id = $1`, [accountId]);
      const used = Number(total!.used);
      if (used + input.content.length > this.quotaBytes) throw new StorageQuotaExceeded(used, this.quotaBytes);
      const result = await client.query<Row>(
        `INSERT INTO hatch_account_files (id, account_id, filename, purpose, bytes, content) VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
        [newId(), accountId, input.filename, input.purpose, input.content.length, input.content]);
      await client.query("COMMIT");
      client.release();
      return fileOf(result.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
      throw error;
    }
  }
  async get(accountId: string, id: string) {
    const result = await this.db.query<Row>(`SELECT ${COLUMNS} FROM hatch_account_files WHERE account_id = $1 AND id = $2`, [accountId, id]);
    return result.rows[0] ? fileOf(result.rows[0]) : undefined;
  }
  async content(accountId: string, id: string) {
    const result = await this.db.query<{ content: Buffer }>(`SELECT content FROM hatch_account_files WHERE account_id = $1 AND id = $2`, [accountId, id]);
    return result.rows[0]?.content;
  }
  async list(accountId: string) {
    const result = await this.db.query<Row>(`SELECT ${COLUMNS} FROM hatch_account_files WHERE account_id = $1 ORDER BY created_at DESC, id`, [accountId]);
    return result.rows.map(fileOf);
  }
  async delete(accountId: string, id: string) {
    const result = await this.db.query(`DELETE FROM hatch_account_files WHERE account_id = $1 AND id = $2 RETURNING id`, [accountId, id]);
    return result.rows.length > 0;
  }
}
