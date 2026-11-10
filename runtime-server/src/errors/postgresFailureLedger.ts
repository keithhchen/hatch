import type { Pool } from "pg";
import type { FailureLedger, FailureRecord } from "./failures.js";

/** Failure records in Postgres: `SELECT * FROM hatch_failures WHERE reference = $1` is how staff look one up. */
export class PostgresFailureLedger implements FailureLedger {
  private ready?: Promise<unknown>;
  constructor(private readonly pool: Pool) {}

  async record(record: FailureRecord): Promise<void> {
    this.ready ??= this.pool.query(`CREATE TABLE IF NOT EXISTS hatch_failures (
      reference TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL, code TEXT NOT NULL, scope JSONB NOT NULL, cause JSONB, detail TEXT NOT NULL)`).catch(error => { this.ready = undefined; throw error; });
    await this.ready;
    await this.pool.query("INSERT INTO hatch_failures (reference, at, code, scope, cause, detail) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",
      [record.reference, record.at, record.code, JSON.stringify(record.scope), record.cause ? JSON.stringify(record.cause) : null, record.detail]);
  }
}
