import { Pool, type PoolConfig } from "pg";
import { log as rootLog, type Log } from "./observability/log.js";

const statementOf = (query: unknown): string =>
  (typeof query === "string" ? query : (query as { text?: string } | undefined)?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Times every `pool.query`: one over the threshold is a `db_slow_query`, a rejected one a `db_query_error`. The line
 * carries the statement's first 200 characters, never its parameters, and the request's ids through the log's context.
 */
export function timedQueries(pool: Pool, log: Log = rootLog, slowMs = Number(process.env.HATCH_DB_SLOW_QUERY_MS) || 500): Pool {
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as { query: unknown }).query = (...args: unknown[]): unknown => {
    if (typeof args[args.length - 1] === "function") return query(...args);
    const started = performance.now();
    const settle = (error?: unknown): void => {
      const duration_ms = Math.round(performance.now() - started);
      if (error !== undefined) log.error("db_query_error", { statement: statementOf(args[0]), duration_ms, error: error instanceof Error ? error.message : String(error) });
      else if (duration_ms > slowMs) log.warn("db_slow_query", { statement: statementOf(args[0]), duration_ms });
    };
    const result = query(...args) as Promise<unknown>;
    return result.then((value) => { settle(); return value; }, (error) => { settle(error ?? "error"); throw error; });
  };
  return pool;
}

/** The one advisory lock every schema change takes; `uuidIdentityMigration` takes the same key, so it queues with them. */
export const SCHEMA_LOCK_KEY = 718263411;
const isSchemaChange = (args: unknown[]): args is [string] => args.length === 1 && typeof args[0] === "string" && /\b(CREATE|ALTER)\s+(UNIQUE\s+)?(TABLE|INDEX)\b/i.test(args[0]);

/**
 * Makes every `CREATE`/`ALTER TABLE|INDEX` statement run under one Postgres advisory lock. Two processes booting side by side
 * (a deploy starts the new container before the old one stops) would otherwise race `IF NOT EXISTS` into a catalog error
 * or a deadlock; now the second waits for the first, then finds the schema already there.
 */
export function serializedSchema(pool: Pool): Pool {
  const query = pool.query.bind(pool) as (...args: unknown[]) => unknown;
  (pool as { query: unknown }).query = (...args: unknown[]): unknown => {
    if (!isSchemaChange(args)) return query(...args);
    return (async () => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
        const result = await client.query(args[0]);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    })();
  };
  return pool;
}

/**
 * A Pool this process owns. An idle client the server cuts off (a restart, a failover, a dropped database) errors on
 * its pool; pg drops that client and the next query opens a new one, so the error is reported, never left to crash
 * the process as an unhandled 'error' event.
 */
export function createPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  pool.on("error", (error) => rootLog.error("postgres_idle_client_error", { message: error.message }));
  return timedQueries(serializedSchema(pool));
}
