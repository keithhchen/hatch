import { Pool, type PoolConfig } from "pg";

/**
 * A Pool this process owns. An idle client the server cuts off (a restart, a failover, a dropped database) errors on
 * its pool; pg drops that client and the next query opens a new one, so the error is reported, never left to crash
 * the process as an unhandled 'error' event.
 */
export function createPool(config: PoolConfig): Pool {
  const pool = new Pool(config);
  pool.on("error", (error) => console.error(JSON.stringify({ event: "postgres_idle_client_error", message: error.message })));
  return pool;
}
